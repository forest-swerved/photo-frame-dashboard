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
    @MainActor func testSharedSignInExchangesProviderTokenForOpaqueRoleDerivedSession() async throws {
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
        let outcome = try await api.accountSignIn(email: "parent@example.test", password: "test-only-password")
        guard case .authenticated(let response) = outcome else { return XCTFail("Expected mobile session") }
        XCTAssertEqual(response.token, token); XCTAssertTrue(response.session.isAdmin)
        XCTAssertEqual(paths, ["/api/auth/sign-in/email", "/api/auth/token", "/api/mobile/sessions"])
    }
    @MainActor func testVerifiedUnlinkedAccountRequiresInvitationBeforeMobileAccess() async throws {
        let api = client(); api.mobileToken = nil
        var paths: [String] = []
        MockProtocol.handler = { request in
            let path = request.url!.path; paths.append(path)
            if path == "/api/auth/sign-in/email" { return (200, Data(#"{"session":{}}"#.utf8)) }
            if path == "/api/auth/token" { return (200, Data(#"{"token":"verified-account-jwt"}"#.utf8)) }
            XCTAssertEqual(path, "/api/mobile/sessions")
            return (403, Data(#"{"error":{"code":"membership_required","message":"Accept an invitation first"}}"#.utf8))
        }
        let outcome = try await api.accountSignIn(email: "child@example.test", password: "test-only-password")
        guard case .invitationRequired = outcome else { return XCTFail("An unlinked account cannot get a mobile credential") }
        XCTAssertEqual(paths, ["/api/auth/sign-in/email", "/api/auth/token", "/api/mobile/sessions"])
        XCTAssertNil(api.mobileToken)
    }
    @MainActor func testSignupRequiresEmailConfirmationWithoutClaimingProfileOrRole() async throws {
        let api = client(); var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1
            XCTAssertEqual(request.url?.path, "/api/auth/sign-up/email")
            let payload = body(request)
            XCTAssertEqual(payload["email"] as? String, "child@example.test")
            XCTAssertEqual(payload["name"] as? String, "Test child")
            XCTAssertNil(payload["role"]); XCTAssertNil(payload["personId"])
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (200, Data(#"{"session":null,"user":null,"confirmationRequired":true}"#.utf8))
        }
        let outcome = try await api.createAccount(name: "Test child", email: "child@example.test", password: "test-only-password")
        guard case .confirmationRequired = outcome else { return XCTFail("Expected emailed confirmation") }
        XCTAssertEqual(requests, 1, "Do not exchange for a mobile session before confirmation")
    }
    @MainActor func testEmailConfirmationAcceptsInvitationBeforeIssuingChildSession() async throws {
        let api = client(); api.mobileToken = nil
        var paths: [String] = []
        let token = String(repeating: "c", count: 43)
        MockProtocol.handler = { [self] request in
            let path = request.url!.path; paths.append(path)
            if path == "/api/auth/verify-email" {
                let payload = body(request)
                XCTAssertEqual(payload["email"] as? String, "child@example.test")
                XCTAssertEqual(payload["token"] as? String, "123456")
                return (200, Data(#"{"session":{}}"#.utf8))
            }
            if path == "/api/auth/token" { return (200, Data(#"{"token":"verified-child-jwt"}"#.utf8)) }
            if path == "/api/join" {
                XCTAssertEqual(body(request)["token"] as? String, "test-only-invitation")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer verified-child-jwt")
                return (200, Data(#"{"data":{"role":"child","personId":"test-person"}}"#.utf8))
            }
            XCTAssertEqual(path, "/api/mobile/sessions")
            return (200, Data("{\"data\":{\"token\":\"\(token)\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"session\":{\"authenticated\":true,\"authType\":\"mobile\",\"role\":\"child\",\"household\":{\"id\":\"test-home\",\"title\":\"Test household\",\"timezone\":\"America/Denver\"},\"user\":{\"id\":\"test-child-account\",\"name\":\"Test child\",\"email\":\"child@example.test\"},\"personId\":\"test-person\"}}}".utf8))
        }
        let outcome = try await api.confirmAccount(email: "child@example.test", code: "123456", invitation: "test-only-invitation")
        guard case .authenticated(let credential) = outcome else { return XCTFail("Expected child mobile session") }
        XCTAssertTrue(credential.session.isChild); XCTAssertFalse(credential.session.isAdmin)
        XCTAssertEqual(credential.session.user.id, "test-child-account"); XCTAssertEqual(credential.session.personId, "test-person")
        XCTAssertEqual(paths, ["/api/auth/verify-email", "/api/auth/token", "/api/join", "/api/mobile/sessions"])
    }
    @MainActor func testUnconfirmedSignInRoutesToConfirmationInsteadOfMobileExchange() async throws {
        let api = client(); var requests = 0
        MockProtocol.handler = { _ in requests += 1; return (403, Data(#"{"error":{"code":"email_not_confirmed","message":"Confirm email"}}"#.utf8)) }
        let outcome = try await api.accountSignIn(email: "child@example.test", password: "test-only-password")
        guard case .confirmationRequired = outcome else { return XCTFail("Expected email confirmation") }
        XCTAssertEqual(requests, 1)
    }
    @MainActor func testChildInvitationIsCreatedForExplicitProfileAndEmail() async throws {
        let api = client()
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/invites")
            let payload = body(request)
            XCTAssertEqual(payload["role"] as? String, "child")
            XCTAssertEqual(payload["personId"] as? String, "test-person")
            XCTAssertEqual(payload["email"] as? String, "child@example.test")
            return (201, Data(#"{"data":{"id":"test-invite","token":"test-only-invitation","expiresAt":"2099-01-01T00:00:00Z","personId":"test-person","email":"child@example.test","role":"child"}}"#.utf8))
        }
        let invite = try await api.createChildInvitation(personID: "test-person", email: "child@example.test")
        XCTAssertEqual(invite.email, "child@example.test"); XCTAssertEqual(invite.role, "child")
    }

    @MainActor func testCancellationDoesNotBecomeAnOfflineError() async throws {
        let api = client()
        MockProtocol.handler = { _ in throw URLError(.cancelled) }
        do { _ = try await api.currentSession(); XCTFail("Expected cancellation") }
        catch is CancellationError { }
        catch { XCTFail("Cancellation must not be shown as an offline failure: \(error)") }
    }

    private var occurrenceJSON: String {
        #"{"id":"daily-task","choreId":"routine-task","date":"2026-10-18","originalDate":"2026-10-18","title":"Synthetic chore","required":true,"instructions":"Synthetic instructions","subtasks":[],"requiresApproval":true,"status":"submitted","version":9,"completion":{"date":"2026-10-18","completed":true,"version":4},"definitionSource":"routine","routineVersion":3}"#
    }
    @MainActor func testOccurrenceCompletionUsesFullOccurrenceVersionRatherThanCompletionVersion() async throws {
        let api = client(), id = UUID().uuidString.lowercased()
        let occurrence = try JSONDecoder().decode(ChoreOccurrence.self, from: Data(occurrenceJSON.utf8))
        let response = Data(("{\"data\":" + occurrenceJSON + "}").utf8)
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/chore-occurrences/daily-task/completion")
            XCTAssertEqual(request.httpMethod, "PUT")
            let payload = body(request)
            XCTAssertEqual(payload["expectedVersion"] as? Int, 9)
            XCTAssertEqual(payload["mutationId"] as? String, id)
            XCTAssertEqual(payload["completed"] as? Bool, false)
            return (200, response)
        }
        let result = try await api.setOccurrenceCompletion(occurrence, completed: false, mutationID: id)
        XCTAssertEqual(result.id, occurrence.id)
    }
    @MainActor func testRescheduleIncludesExplicitNullDeadlineAndVersionedReason() async throws {
        let api = client(), id = UUID().uuidString.lowercased()
        let response = Data(("{\"data\":" + occurrenceJSON + "}").utf8)
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/chore-occurrences/daily-task/actions")
            XCTAssertEqual(request.httpMethod, "POST")
            let payload = body(request)
            XCTAssertEqual(payload["action"] as? String, "reschedule")
            XCTAssertEqual(payload["expectedVersion"] as? Int, 9)
            XCTAssertEqual(payload["mutationId"] as? String, id)
            XCTAssertEqual(payload["toDate"] as? String, "2026-10-19")
            XCTAssertEqual(payload["reason"] as? String, "Synthetic reason")
            XCTAssertTrue(payload["dueTime"] is NSNull)
            return (200, response)
        }
        _ = try await api.changeOccurrence("daily-task", action: OccurrenceAction(action: "reschedule", expectedVersion: 9, mutationId: id, reason: "Synthetic reason", toDate: "2026-10-19"))
    }
    @MainActor func testHistoryUsesBoundedQueryAndChoreBreakRevocationUsesCAS() async throws {
        let api = client(), id = UUID().uuidString.lowercased()
        let breakJSON = #"{"id":"test-break","fromDate":"2026-10-18","toDateExclusive":"2026-10-20","reason":"Synthetic holiday","version":2}"#
        var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1
            if request.url?.path == "/api/chore-history" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "100")
                XCTAssertEqual(query.first(where: { $0.name == "personId" })?.value, "synthetic person")
                XCTAssertEqual(query.first(where: { $0.name == "to" })?.value, "2026-10-21")
                return (200, Data(#"{"data":{"history":[]}}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/chore-exceptions/test-break/revoke")
            XCTAssertEqual(request.httpMethod, "POST")
            let payload = body(request)
            XCTAssertEqual(payload["expectedVersion"] as? Int, 2)
            XCTAssertEqual(payload["reason"] as? String, "Synthetic removal")
            XCTAssertEqual(payload["mutationId"] as? String, id)
            return (200, Data(("{\"data\":" + breakJSON + "}").utf8))
        }
        _ = try await api.choreHistory(from: "2026-10-01", to: "2026-10-21", personID: "synthetic person")
        let item = try JSONDecoder().decode(ChoreBreak.self, from: Data(breakJSON.utf8))
        _ = try await api.revokeChoreBreak(item, reason: "Synthetic removal", mutationID: id)
        XCTAssertEqual(requests, 2)
    }
    @MainActor func testPasswordRecoveryUsesOnlyProofAndDoesNotCreateAMobileSession() async throws {
        let api = client(); var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let payload = body(request)
            if request.url?.path == "/api/auth/request-password-reset" { XCTAssertEqual(payload["email"] as? String, "synthetic@example.test") }
            else {
                XCTAssertEqual(request.url?.path, "/api/auth/reset-password")
                XCTAssertEqual(payload["token"] as? String, "000000"); XCTAssertEqual(payload["password"] as? String, "test-only-password")
                XCTAssertNil(payload["role"]); XCTAssertNil(payload["recoveryLink"])
            }
            return (200, Data("{}".utf8))
        }
        try await api.requestPasswordReset(email: "synthetic@example.test")
        try await api.resetPassword(email: "synthetic@example.test", token: "000000", recoveryLink: "", password: "test-only-password")
        XCTAssertEqual(requests, 2)
    }
    @MainActor func testFrameUnlockUsesSelectedScopeAndCaregiverPermissionsAreExplicit() async throws {
        let api = client(); var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1; let payload = body(request)
            if request.url?.path == "/api/frame-access-codes" {
                XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(payload["scope"] as? String, "child"); XCTAssertEqual(payload["personId"] as? String, "test-person")
                return (201, Data(#"{"data":{"code":"000000","scope":"child","personId":"test-person","expiresAt":"2099-01-01T00:00:00Z"}}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/members/test-member/capabilities"); XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(payload["manageChores"] as? Bool, true); XCTAssertEqual(payload["manageInternet"] as? Bool, false)
            return (200, Data(#"{"data":{"id":"test-member","capabilities":{"manageChores":true,"manageInternet":false}}}"#.utf8))
        }
        _ = try await api.createFrameAccessCode(scope: "child", personID: "test-person")
        _ = try await api.changeMemberCapabilities("test-member", capabilities: ParentCapabilities(manageChores: true, manageInternet: false))
        XCTAssertEqual(requests, 2)
    }

}
