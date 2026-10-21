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
    @MainActor func testSchoolCalendarReadAndVersionedOverrideUseAuthenticatedContract() async throws {
        let api = client(); api.mobileToken = "test-school-token"
        let response = Data(#"{"data":{"calendar":null,"schoolDay":{"date":"2026-10-18","type":"unknown","label":"School schedule needed","reason":"Synthetic missing calendar","calendarVersion":null}}}"#.utf8)
        var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1; XCTAssertEqual(request.url?.path, "/api/school-calendar")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "FamilyMobile test-school-token")
            if request.httpMethod == "GET" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(query?.first(where: { $0.name == "date" })?.value, "2026-10-18")
            } else {
                XCTAssertEqual(request.httpMethod, "PATCH")
                let payload = body(request), change = try XCTUnwrap(payload["override"] as? [String: Any])
                XCTAssertEqual(payload["expectedVersion"] as? Int, 7)
                XCTAssertEqual(change["date"] as? String, "2026-10-18"); XCTAssertEqual(change["type"] as? String, "school_day")
                XCTAssertEqual(change["reason"] as? String, "Synthetic school date change")
                XCTAssertNil(payload["householdId"], "The household is derived from the signed-in account")
            }
            return (200, response)
        }
        let calendar = try await api.schoolCalendar(date: "2026-10-18")
        XCTAssertNil(calendar.calendar); XCTAssertFalse(calendar.schoolDay.isKnown)
        _ = try await api.changeSchoolDay(.init(expectedVersion: 7, change: .init(date: "2026-10-18", type: "school_day", reason: "Synthetic school date change")))
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
    private var networkSessionJSON: String {
        #"{"id":"test-session","personId":"test-person","deviceId":"test-console","creditId":"test-credit","source":"reward","state":"starting","version":4,"desiredState":"allowed","observedState":"unknown","requestedAt":"2026-10-17T18:00:00Z","endsAt":null,"remainingSeconds":3600,"allDay":false}"#
    }
    @MainActor func testInternetRedemptionAcceptsPending202WithoutAnotherMutation() async throws {
        let api = client(), mutation = UUID().uuidString.lowercased(); var requests = 0
        let response = Data(("{\"data\":" + networkSessionJSON + "}").utf8)
        MockProtocol.handler = { [self] request in
            requests += 1; XCTAssertEqual(request.url?.path, "/api/internet/redeem"); XCTAssertEqual(request.httpMethod, "POST")
            let payload = body(request); XCTAssertEqual(payload["creditId"] as? String, "test-credit"); XCTAssertEqual(payload["deviceId"] as? String, "test-console"); XCTAssertEqual(payload["mutationId"] as? String, mutation)
            XCTAssertNil(payload["minutes"], "The server chooses minutes from the earned credit")
            return (202, response)
        }
        let result = try await api.redeemInternet(creditID: "test-credit", deviceID: "test-console", mutationID: mutation)
        XCTAssertEqual(result.state, "starting"); XCTAssertFalse(result.hasVerifiedAccess); XCTAssertTrue(result.hasPendingWindow); XCTAssertEqual(requests, 1)
    }
    @MainActor func testParentAllDayGrantAndVersionedNegativeTimeAdjustment() async throws {
        let api = client(), mutation = UUID().uuidString.lowercased()
        let response = Data(("{\"data\":" + networkSessionJSON + "}").utf8); var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1; let payload = body(request)
            if request.url?.path == "/api/internet/grants" {
                XCTAssertEqual(payload["allDay"] as? Bool, true); XCTAssertNil(payload["minutes"])
                XCTAssertEqual(payload["personId"] as? String, "test-person"); XCTAssertEqual(payload["reason"] as? String, "Synthetic holiday")
            } else {
                XCTAssertEqual(request.url?.path, "/api/internet/sessions/test-session/actions")
                XCTAssertEqual(payload["action"] as? String, "adjust"); XCTAssertEqual(payload["expectedVersion"] as? Int, 4); XCTAssertEqual(payload["deltaMinutes"] as? Int, -15)
            }
            XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(payload["mutationId"] as? String, mutation); return (202, response)
        }
        _ = try await api.grantInternet(personID: "test-person", deviceID: "test-console", minutes: nil, allDay: true, reason: "Synthetic holiday", mutationID: mutation)
        _ = try await api.changeInternetSession("test-session", action: InternetSessionAction(action: "adjust", expectedVersion: 4, mutationId: mutation, deltaMinutes: -15))
        XCTAssertEqual(requests, 2)
    }
    @MainActor func testManagedDevicePatchAndDeleteKeepVersionMutationAndNotificationTransport() async throws {
        let api = client(), mutation = UUID().uuidString.lowercased()
        let json = #"{"id":"test-tablet","name":"Synthetic tablet","kind":"tablet","personIds":["test-person"],"macAddresses":["02:00:00:00:00:01"],"version":2,"controlState":"unenrolled","allowApplePush":true}"#
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/internet/devices/test-tablet")
            if request.httpMethod == "PATCH" {
                let payload = body(request); XCTAssertEqual(payload["expectedVersion"] as? Int, 1); XCTAssertEqual(payload["mutationId"] as? String, mutation)
                XCTAssertEqual(payload["allowApplePush"] as? Bool, true); XCTAssertEqual(payload["personIds"] as? [String], ["test-person"])
                return (200, Data(("{\"data\":" + json + "}").utf8))
            }
            XCTAssertEqual(request.httpMethod, "DELETE")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first(where: { $0.name == "expectedVersion" })?.value, "2"); XCTAssertEqual(query.first(where: { $0.name == "mutationId" })?.value, mutation)
            return (200, Data(#"{"data":{"deleted":true}}"#.utf8))
        }
        var draft = ManagedDeviceDraft(name: "Synthetic tablet", kind: "tablet", personIds: ["test-person"], macAddresses: ["02:00:00:00:00:01"], mutationId: mutation, expectedVersion: 1); draft.allowApplePush = true
        let result = try await api.saveInternetDevice(draft, id: "test-tablet"); XCTAssertEqual(result.allowApplePush, true)
        try await api.deleteInternetDevice(result, mutationID: mutation)
    }
    @MainActor func testRewardPolicyClearsBedtimeAndReviewResolutionIncludesParentReason() async throws {
        let api = client(), mutation = UUID().uuidString.lowercased(); var requests = 0
        MockProtocol.handler = { [self] request in
            requests += 1; let payload = body(request)
            if request.url?.path == "/api/internet/policies/test-person" {
                XCTAssertEqual(request.httpMethod, "PUT"); XCTAssertEqual(payload["expectedVersion"] as? Int, 0); XCTAssertTrue(payload["bedtime"] is NSNull)
                return (200, Data(#"{"data":{"personId":"test-person","version":1,"rewardMinutes":60,"carryoverDays":7,"dailyLimitMinutes":180,"warningMinutes":5,"enabled":true}}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/internet/credits/test-credit/resolve"); XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(payload["action"] as? String, "restore"); XCTAssertEqual(payload["reason"] as? String, "Synthetic provider review"); XCTAssertEqual(payload["mutationId"] as? String, mutation)
            return (200, Data(#"{"data":{"id":"test-credit","personId":"test-person","earnedDate":"2026-10-17","minutes":60,"status":"available","expiresAt":"2026-10-25T06:00:00Z","policyVersion":1}}"#.utf8))
        }
        _ = try await api.saveInternetPolicy("test-person", draft: RewardPolicyDraft(expectedVersion: 0, rewardMinutes: 60, carryoverDays: 7, dailyLimitMinutes: 180, bedtime: nil, warningMinutes: 5, enabled: true))
        _ = try await api.resolveInternetCredit("test-credit", action: "restore", reason: "Synthetic provider review", mutationID: mutation)
        XCTAssertEqual(requests, 2)
    }
    @MainActor func testAccountDeletionSendsFreshPasswordConfirmationAndWorksWithoutMobileCredential() async throws {
        let api = client(); api.mobileToken = nil; var paths: [String] = []
        MockProtocol.handler = { [self] request in
            paths.append(request.url!.path)
            if request.url?.path == "/api/auth/token" {
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, Data(#"{"token":"verified-unlinked-account-proof"}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/account/delete"); XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer verified-unlinked-account-proof", "Resolve the first-party BFF account identity without requiring family membership")
            let payload = body(request); XCTAssertEqual(payload["password"] as? String, "test-only-password"); XCTAssertEqual(payload["confirmation"] as? String, "DELETE MY ACCOUNT")
            XCTAssertNil(payload["email"]); XCTAssertNil(payload["userId"]); XCTAssertNil(payload["householdId"])
            return (200, Data(#"{"data":{"deleted":true}}"#.utf8))
        }
        try await api.deleteAccount(password: "test-only-password")
        XCTAssertEqual(paths, ["/api/auth/token", "/api/account/delete"], "Deletion must never claim/join a family or issue a mobile session")
    }
    @MainActor func testDeletionMustBeExplicitlyConfirmedByResponseAndTransferMustMatchRecipient() async throws {
        let api = client()
        MockProtocol.handler = { _ in (200, Data(#"{"data":{"deleted":false}}"#.utf8)) }
        do { try await api.deleteAccount(password: "test-only-password"); XCTFail("Do not claim unconfirmed deletion") } catch let error as APIError { XCTAssertEqual(error.code, "deletion_unconfirmed") }
        MockProtocol.handler = { [self] request in
            XCTAssertEqual(request.url?.path, "/api/account/transfer-ownership"); XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(body(request)["userId"] as? String, "test-caregiver")
            return (200, Data(#"{"data":{"transferred":true,"userId":"different-user"}}"#.utf8))
        }
        do { try await api.transferOwnership(userID: "test-caregiver"); XCTFail("Transfer recipient must match") } catch let error as APIError { XCTAssertEqual(error.code, "transfer_unconfirmed") }
    }

}
