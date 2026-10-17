import XCTest
@testable import FamilyFrame

final class SecureStorageTests: XCTestCase {
    func testInstallationUUIDIsStableAndCanRotateWithoutPersistingAPNsToken() throws {
        let store = SecureStore(service: "com.swerved.familyframe.test.\(UUID().uuidString)")
        let initial = try store.installationID()
        XCTAssertNotNil(UUID(uuidString: initial))
        XCTAssertEqual(try store.installationID(), initial)
        let replacement = try store.replaceInstallationID()
        XCTAssertNotEqual(initial, replacement)
        XCTAssertEqual(try store.installationID(), replacement)
        try store.clear()
        XCTAssertEqual(try store.installationID(), replacement, "Local sign-out preserves the installation UUID")
    }
    func testCredentialRoundTripAndLocalDeletion() throws {
        let store = SecureStore(service: "com.swerved.familyframe.test.\(UUID().uuidString)")
        let session = MobileSession(authenticated: true, authType: "mobile", role: "child", household: Household(id: "test-home", title: "Test-only household", timezone: "America/Denver"), user: FamilyUser(id: "test-child", name: "Test child", email: nil), personId: "test-child")
        let credential = MobileCredential(token: String(repeating: "a", count: 43), expiresAt: "2099-01-01T00:00:00Z", session: session)
        try store.save(credential)
        XCTAssertEqual(try store.load()?.session, session)
        XCTAssertTrue(try XCTUnwrap(store.load()).isValid)
        try store.clear()
        XCTAssertNil(try store.load())
    }
}
