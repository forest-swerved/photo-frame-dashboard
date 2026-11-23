import Foundation
import Security

struct DeviceWidgetCredential: Codable, Equatable {
    let token: String
    let expiresAt: String
}
struct DeviceWidgetSnapshot: Decodable {
    let checkedAt: Date
    let items: [DeviceWidgetItem]
}
struct DeviceWidgetItem: Decodable, Identifiable {
    let id: String
    let device: String
    let person: String
    let status: String
    let defaultOffOn: Bool
    let endsAt: Date?
    let preparationEndsAt: Date?
    func label(at date: Date) -> String {
        if let end = endsAt, end <= date { return "Confirming block" }
        if let preparation = preparationEndsAt, preparation > date { return "Getting ready" }
        return status
    }
}

// Only the scoped widget credential is available while locked. The app's full
// mobile credential remains in its original WhenUnlocked-only keychain item.
enum DeviceWidgetStore {
    static let kind = "FamilyDeviceStatus"
    private static var query: [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "WidgetKeychainGroup") as? String, !group.contains("$(") else { return [:] }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "com.swerved.familyframe.device-widget",
                kSecAttrAccount as String: "read-only-status", kSecAttrAccessGroup as String: group]
    }
    static func load() -> DeviceWidgetCredential? {
        var request = query; guard !request.isEmpty else { return nil }
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceWidgetCredential.self, from: data)
    }
    static func save(_ value: DeviceWidgetCredential) throws {
        let request = query; guard !request.isEmpty else { throw CocoaError(.fileWriteNoPermission) }
        let data = try JSONEncoder().encode(value)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(request.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    static func clear() { let request = query; if !request.isEmpty { SecItemDelete(request as CFDictionary) } }
}
