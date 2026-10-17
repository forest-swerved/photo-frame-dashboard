import XCTest
@testable import FamilyFrame

final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}

final class APIClientTests: XCTestCase {
    override func tearDown() { MockProtocol.handler = nil; super.tearDown() }
    @MainActor private func client() -> APIClient {
        let c = URLSessionConfiguration.ephemeral; c.protocolClasses = [MockProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://frame.test")!, configuration: c)
        api.mobileToken = String(repeating: "a", count: 43)
        return api
    }
    private func body(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    @MainActor func testMobileCompletionCarriesVersionAndMutationID() async throws {
        let api = client(), id = UUID().uuidString.lowercased()
        let chore = Chore(id: "test-chore", title: "Test-only chore", personId: nil, weekdays: [0], version: 3, dueTime: "18:00", reminderMinutes: 15,
                          completion: ChoreCompletion(date: "2026-10-18", completed: false, version: 6, updatedAt: nil))
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/chores/test-chore/completions/2026-10-18")
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "FamilyMobile \(String(repeating: "a", count: 43))")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://frame.test")
            let payload = body(request)
            XCTAssertEqual(payload["expectedVersion"] as? Int, 6)
            XCTAssertEqual(payload["mutationId"] as? String, id)
            XCTAssertEqual(payload["completed"] as? Bool, true)
            return (200, Data("{\"data\":{\"choreId\":\"test-chore\",\"date\":\"2026-10-18\",\"completed\":true,\"version\":7,\"mutationId\":\"\(id)\"}}".utf8))
        }
        let response = try await api.setCompletion(chore, date: "2026-10-18", completed: true, mutationID: id)
        XCTAssertEqual(response.version, 7); XCTAssertTrue(response.completed)
    }
    @MainActor func testConflictIsReturnedWithoutAutomaticOverwriteOrRetry() async throws {
        let api = client(); var requests = 0
        MockProtocol.handler = { _ in requests += 1; return (409, Data(#"{"error":{"code":"version_conflict","message":"Changed elsewhere"}}"#.utf8)) }
        do { let _ = try await api.currentSession(); XCTFail("Expected conflict") }
        catch let error as APIError { XCTAssertEqual(error.status, 409); XCTAssertTrue(error.isConflict) }
        XCTAssertEqual(requests, 1)
    }
    @MainActor func testExpiredSessionIsNotReportedAsOffline() async throws {
        let api = client()
        MockProtocol.handler = { _ in (401, Data(#"{"error":{"code":"mobile_session_revoked","message":"Pair again"}}"#.utf8)) }
        do { let _ = try await api.currentSession(); XCTFail("Expected revoked session") }
        catch let error as APIError { XCTAssertTrue(error.isAuthenticationFailure); XCTAssertEqual(error.code, "mobile_session_revoked") }
    }
    @MainActor func testAPNsRegistrationIncludesStableInstallationAndEnvironment() async throws {
        let api = client()
        let installation = UUID().uuidString.lowercased()
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/mobile/push-installations")
            let payload = body(request)
            XCTAssertEqual(payload["installationId"] as? String, installation)
            XCTAssertEqual(payload["environment"] as? String, "sandbox")
            XCTAssertEqual(payload["token"] as? String, "test-token")
            return (200, Data(#"{"data":{"registered":true}}"#.utf8))
        }
        try await api.registerPush(token: "test-token", environment: "sandbox", installationID: installation)
    }
    @MainActor func testParentSignInExchangesProviderTokenForOpaqueMobileSession() async throws {
        let api = client(); var paths: [String] = []
        let token = String(repeating: "b", count: 43)
        MockProtocol.handler = { [self] request in
            let path = request.url!.path; paths.append(path)
            if path == "/api/auth/sign-in/email" {
                XCTAssertEqual(body(request)["email"] as? String, "parent@example.test")
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, Data(#"{"session":{"expiresAt":"2099-01-01T00:00:00Z"},"user":{"id":"test-parent"}}"#.utf8))
            }
            if path == "/api/auth/token" { return (200, Data(#"{"token":"test-provider-jwt"}"#.utf8)) }
            XCTAssertEqual(path, "/api/mobile/sessions")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-provider-jwt")
            return (200, Data("{\"data\":{\"token\":\"\(token)\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"session\":{\"authenticated\":true,\"authType\":\"mobile\",\"role\":\"admin\",\"household\":{\"id\":\"test-home\",\"title\":\"Test household\",\"timezone\":\"America/Denver\"},\"user\":{\"id\":\"test-parent\",\"name\":\"Test parent\"}}}}".utf8))
        }
        let response = try await api.parentLogin(email: "parent@example.test", password: "test-only-password")
        XCTAssertEqual(response.token, token); XCTAssertTrue(response.session.isAdmin)
        XCTAssertEqual(paths, ["/api/auth/sign-in/email", "/api/auth/token", "/api/mobile/sessions"])
    }
}
