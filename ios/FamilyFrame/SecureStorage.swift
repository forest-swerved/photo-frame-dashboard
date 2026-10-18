import Foundation
import Security

protocol CredentialStoring {
    func load() throws -> MobileCredential?
    func save(_ credential: MobileCredential) throws
    func clear() throws
    func installationID() throws -> String
    func replaceInstallationID() throws -> String
}

protocol DashboardCaching {
    func read(identity: String) -> CachedDashboard?
    func write(_ value: CachedDashboard) throws
    func clear()
}

struct SecureStore: CredentialStoring {
    private let service: String
    init(service: String = "com.swerved.familyframe.mobile-session") { self.service = service }
    private let account = "current"
    func load() throws -> MobileCredential? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StorageError.keychain }
        return try JSONDecoder().decode(MobileCredential.self, from: data)
    }
    func save(_ credential: MobileCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            var entry = query; attributes.forEach { entry[$0.key] = $0.value }
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw StorageError.keychain }
        } else if updated != errSecSuccess { throw StorageError.keychain }
    }
    func installationID() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccount as String: "installation", kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8), UUID(uuidString: text) != nil { return text }
        guard status == errSecItemNotFound else { throw StorageError.keychain }
        return try replaceInstallationID()
    }
    // Called only after the server explicitly rejects a stale installation binding.
    func replaceInstallationID() throws -> String {
        let id = UUID().uuidString.lowercased()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "installation"]
        let attributes: [String: Any] = [kSecValueData as String: Data(id.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query; attributes.forEach { entry[$0.key] = $0.value }
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw StorageError.keychain }
        } else if status != errSecSuccess { throw StorageError.keychain }
        return id
    }
    func clear() throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError.keychain }
    }
}

enum StorageError: LocalizedError {
    case keychain, protection
    var errorDescription: String? { "The app could not access protected storage. Unlock your device and try again." }
}

struct DashboardCache: DashboardCaching {
    private let directory: URL
    init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FamilyFrame", isDirectory: true)
    }
    private var file: URL { directory.appendingPathComponent("dashboard.json") }
    func read(identity: String) -> CachedDashboard? {
        guard let data = try? Data(contentsOf: file), let cache = try? JSONDecoder().decode(CachedDashboard.self, from: data), cache.identity == identity else { return nil }
        return cache
    }
    func write(_ value: CachedDashboard) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var excluded = directory
        var resources = URLResourceValues(); resources.isExcludedFromBackup = true
        try excluded.setResourceValues(resources)
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
    }
    func clear() { try? FileManager.default.removeItem(at: directory) }
}
