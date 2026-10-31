import Foundation

struct APIError: Error, LocalizedError, Equatable {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
    var isAuthenticationFailure: Bool { status == 401 }
    var isConflict: Bool { status == 409 }
}

private struct Envelope<T: Decodable>: Decodable { let data: T }
private struct ErrorEnvelope: Decodable {
    struct Failure: Decodable { let code: String; let message: String }
    let error: Failure
}

// Prevent a redirect from forwarding a bearer credential or parent login body.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
protocol FamilyAPI: AnyObject {
    var mobileToken: String? { get set }
    func accountSignIn(email: String, password: String, invitation: String) async throws -> AccountOutcome
    func createAccount(name: String, email: String, password: String, invitation: String) async throws -> AccountOutcome
    func confirmAccount(email: String, code: String, invitation: String) async throws -> AccountOutcome
    func resendConfirmation(email: String) async throws
    func requestPasswordReset(email: String) async throws
    func resetPassword(email: String, token: String, recoveryLink: String, password: String) async throws
    func joinFamily(invitation: String) async throws -> AccountOutcome
    func cancelAccountOnboarding() async
    func serviceStatus() async throws -> MobileServiceStatus
    func currentSession() async throws -> MobileSession
    func signOut() async throws
    func household(date: String) async throws -> HouseholdSnapshot
    func calendar(from: String, to: String) async throws -> CalendarSnapshot
    func setCompletion(_ chore: Chore, date: String, completed: Bool, mutationID: String) async throws -> CompletionResult
    func saveChore(_ draft: ChoreDraft, id: String?) async throws
    func createTasks(_ draft: ChoreDraft, personIDs: [String], mutationID: String) async throws
    func deleteChore(_ chore: Chore) async throws
    func createChildInvitation(personID: String, email: String) async throws -> ChildInvitation
    func devices() async throws -> [MobileDevice]
    func revokeDevice(id: String) async throws
    func registerPush(token: String, environment: String, installationID: String) async throws
    func sendTestNotification() async throws
    func preferences() async throws -> NotificationPreferences
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences
    func notifications() async throws -> [FamilyNotification]
    func markRead(id: String) async throws
    func markAllNotificationsRead() async throws
    func setOccurrenceCompletion(_ occurrence: ChoreOccurrence, completed: Bool, mutationID: String) async throws -> ChoreOccurrence
    func changeOccurrence(_ id: String, action: OccurrenceAction) async throws -> ChoreOccurrence
    func choreHistory(from: String, to: String, personID: String?) async throws -> [ChoreHistoryItem]
    func choreBreaks() async throws -> [ChoreBreak]
    func schoolCalendar(date: String) async throws -> SchoolCalendarResponse
    func changeSchoolDay(_ draft: SchoolDayOverrideDraft) async throws -> SchoolCalendarResponse
    func createChoreBreak(_ draft: ChoreBreakDraft) async throws -> ChoreBreak
    func revokeChoreBreak(_ item: ChoreBreak, reason: String, mutationID: String) async throws -> ChoreBreak
    func createFrameAccessCode(scope: String, personID: String?) async throws -> FrameAccessCode
    func parentPin(pin: String?) async throws -> ParentPinStatus
    func members() async throws -> [FamilyMember]
    func changeMemberCapabilities(_ id: String, capabilities: ParentCapabilities) async throws -> MemberCapabilitiesResult
    func internet() async throws -> InternetSnapshot
    func requestDeviceAccess(deviceID: String, minutes: Int, reason: String?, mutationID: String) async throws -> DeviceAccessRequest
    func decideDeviceAccess(_ item: DeviceAccessRequest, approve: Bool, mutationID: String) async throws -> DeviceAccessRequest
    func redeemInternet(creditID: String, deviceID: String, mutationID: String) async throws -> InternetSession
    func grantInternet(personID: String, deviceID: String, minutes: Int?, allDay: Bool, reason: String?, mutationID: String) async throws -> InternetSession
    func changeInternetSession(_ id: String, action: InternetSessionAction) async throws -> InternetSession
    func changeDeviceAccess(_ device: ManagedInternetDevice, access: String, mutationID: String) async throws -> ManagedInternetDevice
    func saveInternetDevice(_ draft: ManagedDeviceDraft, id: String?) async throws -> ManagedInternetDevice
    func deleteInternetDevice(_ item: ManagedInternetDevice, mutationID: String) async throws
    func saveInternetPolicy(_ personID: String, draft: RewardPolicyDraft) async throws -> RewardPolicy
    func resolveInternetCredit(_ id: String, action: String, reason: String, mutationID: String) async throws -> RewardCredit
    func internetHistory() async throws -> [InternetHistoryItem]
    func deleteAccount(password: String) async throws
    func transferOwnership(userID: String) async throws
    func locationHistory() async throws -> LocationHistorySummary
    func changeLocationHistory(_ draft:LocationHistoryDraft) async throws -> LocationHistoryChange
    func deleteLocationHistory() async throws
    func parentLocations() async throws -> ParentLocationSnapshot
    func changeLocationSharing(_ draft: LocationSharingDraft) async throws -> LocationSharingResult
    func mediaList() async throws -> MediaList
    func uploadPhoto(id: String, data: Data) async throws -> FamilyMedia
    func reserveVideo(id: String, draft: VideoDraft) async throws -> VideoReservation
    func uploadVideo(file: URL, signedURL: String) async throws
    func finishVideo(id: String) async throws -> FamilyMedia
    func removeMedia(id: String) async throws
    func mediaPhoto(id: String) async throws -> Data
}

@MainActor
final class APIClient: FamilyAPI {
    let baseURL: URL
    private let session: URLSession
    private let redirectDelegate = NoRedirectDelegate()
    private lazy var mediaSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil
        config.httpCookieStorage = nil; config.timeoutIntervalForRequest = 300; config.timeoutIntervalForResource = 600
        return URLSession(configuration: config, delegate: redirectDelegate, delegateQueue: nil)
    }()
    var mobileToken: String?
    nonisolated static var configuredURL: URL {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "FamilyAPIBaseURL") as? String,
              let url = validatedBaseURL(raw) else { preconditionFailure("Set a valid HTTPS FamilyAPIBaseURL in the app configuration.") }
        return url
    }
    nonisolated static func validatedBaseURL(_ raw: String) -> URL? {
        guard let u = URL(string: raw), u.scheme == "https", u.host != nil,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              u.path.isEmpty || u.path == "/", u.port == nil || u.port == 443 else { return nil }
        return URL(string: "https://\(u.host!)")
    }
    init(baseURL: URL = APIClient.configuredURL, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 40
        configuration.httpCookieAcceptPolicy = .onlyFromMainDocumentDomain
        session = URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
    }
    private func send<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                                     authorization: String? = nil, wrapped: Bool = true, authenticated: Bool = true, contentType: String = "application/json") async throws -> T {
        guard path.hasPrefix("/api/"), !path.contains(".."), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.host == baseURL.host, url.scheme == baseURL.scheme else {
            throw APIError(status: 0, code: "invalid_endpoint", message: "The app configuration is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body
        request.mainDocumentURL = baseURL
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        else if authenticated, let mobileToken { request.setValue("FamilyMobile \(mobileToken)", forHTTPHeaderField: "Authorization") }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, data.count <= 2_000_000 else {
                throw APIError(status: 0, code: "invalid_response", message: "The server returned an invalid response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let failure = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
                throw APIError(status: http.statusCode, code: failure?.error.code ?? "request_failed",
                               message: failure?.error.message ?? "The request could not be completed. Try again.")
            }
            do {
                return try wrapped ? JSONDecoder().decode(Envelope<T>.self, from: data).data : JSONDecoder().decode(T.self, from: data)
            } catch { throw APIError(status: 0, code: "invalid_response", message: "The app could not read this response. Refresh or update the app.") }
        } catch let error as APIError { throw error }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch {
            throw APIError(status: 0, code: "network_error", message: "Cannot reach Family Frame. Check your connection, then refresh before trying changes again.")
        }
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }
    private func clearLoginCookies() {
        session.configuration.httpCookieStorage?.cookies?.forEach { session.configuration.httpCookieStorage?.deleteCookie($0) }
    }
    func accountSignIn(email: String, password: String, invitation: String = "") async throws -> AccountOutcome {
        clearLoginCookies()
        do {
            let _: Acknowledgement = try await send("/api/auth/sign-in/email", method: "POST", body: encoded(["email": email, "password": password]), wrapped: false, authenticated: false)
        } catch let error as APIError where error.code == "email_not_confirmed" {
            return .confirmationRequired
        } catch { clearLoginCookies(); throw error }
        return try await finishAccount(invitation: invitation)
    }
    func createAccount(name: String, email: String, password: String, invitation: String = "") async throws -> AccountOutcome {
        clearLoginCookies()
        struct SignupResult: Decodable { let confirmationRequired: Bool? }
        let result: SignupResult = try await send("/api/auth/sign-up/email", method: "POST", body: encoded(["name": name, "email": email, "password": password]), wrapped: false, authenticated: false)
        if result.confirmationRequired == true { return .confirmationRequired }
        return try await finishAccount(invitation: invitation)
    }
    func confirmAccount(email: String, code: String, invitation: String = "") async throws -> AccountOutcome {
        let _: Acknowledgement = try await send("/api/auth/verify-email", method: "POST", body: encoded(["email": email, "token": code]), wrapped: false, authenticated: false)
        return try await finishAccount(invitation: invitation)
    }
    func resendConfirmation(email: String) async throws {
        let _: Acknowledgement = try await send("/api/auth/resend-verification", method: "POST", body: encoded(["email": email]), wrapped: false, authenticated: false)
    }
    func requestPasswordReset(email: String) async throws {
        clearLoginCookies()
        let _: Acknowledgement = try await send("/api/auth/request-password-reset", method: "POST", body: encoded(["email": email]), wrapped: false, authenticated: false)
    }
    func resetPassword(email: String, token: String, recoveryLink: String, password: String) async throws {
        defer { clearLoginCookies() }
        let payload = recoveryLink.isEmpty ? ["email": email, "token": token, "password": password] : ["recoveryLink": recoveryLink, "password": password]
        let _: Acknowledgement = try await send("/api/auth/reset-password", method: "POST", body: encoded(payload), wrapped: false, authenticated: false)
    }
    func joinFamily(invitation: String) async throws -> AccountOutcome { try await finishAccount(invitation: invitation) }
    private func finishAccount(invitation: String) async throws -> AccountOutcome {
        struct AuthToken: Decodable { let token: String }
        let auth: AuthToken = try await send("/api/auth/token", wrapped: false, authenticated: false)
        if !invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let _: Acknowledgement = try await send("/api/join", method: "POST", body: encoded(["token": invitation.trimmingCharacters(in: .whitespacesAndNewlines)]), authorization: "Bearer \(auth.token)", authenticated: false)
        }
        do {
            let credential: MobileCredential = try await send("/api/mobile/sessions", method: "POST", body: Data("{}".utf8), authorization: "Bearer \(auth.token)", authenticated: false)
            clearLoginCookies()
            return .authenticated(credential)
        } catch let error as APIError where error.status == 403 && error.code == "membership_required" {
            // Keep only the ephemeral BFF cookie so the verified account can accept an invitation.
            return .invitationRequired
        }
    }
    func cancelAccountOnboarding() async {
        let _: Acknowledgement? = try? await send("/api/auth/sign-out", method: "POST", body: Data("{}".utf8), wrapped: false, authenticated: false)
        clearLoginCookies()
    }
    func serviceStatus() async throws -> MobileServiceStatus { try await send("/api/mobile/status") }
    func currentSession() async throws -> MobileSession { try await send("/api/mobile/session") }
    func signOut() async throws { let _: Acknowledgement = try await send("/api/mobile/session", method: "DELETE") }
    func household(date: String) async throws -> HouseholdSnapshot { try await send("/api/household?date=\(date)") }
    func calendar(from: String, to: String) async throws -> CalendarSnapshot { try await send("/api/calendar?from=\(from)&to=\(to)") }
    func setCompletion(_ chore: Chore, date: String, completed: Bool, mutationID: String) async throws -> CompletionResult {
        struct Change: Encodable { let completed: Bool; let expectedVersion: Int; let mutationId: String }
        return try await send("/api/chores/\(chore.id)/completions/\(date)", method: "PUT",
                              body: encoded(Change(completed: completed, expectedVersion: chore.completion.version, mutationId: mutationID)))
    }
    func saveChore(_ draft: ChoreDraft, id: String?) async throws {
        let _: Acknowledgement = try await send(id.map { "/api/chores/\($0)" } ?? "/api/chores", method: id == nil ? "POST" : "PATCH", body: encoded(draft))
    }
    func createTasks(_ draft: ChoreDraft, personIDs: [String], mutationID: String) async throws {
        let _: Acknowledgement = try await send("/api/chores/batch", method: "POST", body: encoded(TaskCreationRequest(draft: draft, personIds: personIDs, mutationId: mutationID)))
    }
    func deleteChore(_ chore: Chore) async throws {
        let _: Acknowledgement = try await send("/api/chores/\(chore.id)?expectedVersion=\(chore.version)", method: "DELETE")
    }
    func createChildInvitation(personID: String, email: String) async throws -> ChildInvitation {
        struct ChildInviteRequest: Encodable { let role = "child"; let personId: String; let email: String; let expiresInHours = 24 }
        return try await send("/api/invites", method: "POST", body: encoded(ChildInviteRequest(personId: personID, email: email)))
    }
    func devices() async throws -> [MobileDevice] { let result: MobileDevices = try await send("/api/mobile/devices"); return result.devices }
    func revokeDevice(id: String) async throws { let _: Acknowledgement = try await send("/api/mobile/devices/\(id)", method: "DELETE") }
    func registerPush(token: String, environment: String, installationID: String) async throws {
        let _: Acknowledgement = try await send("/api/mobile/push-installations", method: "POST", body: encoded(["token": token, "environment": environment, "installationId": installationID]))
    }
    func sendTestNotification() async throws {
        struct Result: Decodable { let accepted: Bool }
        let result: Result = try await send("/api/mobile/notifications/test", method: "POST", body: Data("{}".utf8))
        guard result.accepted else { throw APIError(status: 502, code: "push_test_rejected", message: "Apple did not accept this test notification.") }
    }
    func preferences() async throws -> NotificationPreferences { try await send("/api/mobile/notification-preferences") }
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences {
        try await send("/api/mobile/notification-preferences", method: "PUT", body: encoded(prefs))
    }
    func notifications() async throws -> [FamilyNotification] {
        let list: NotificationList = try await send("/api/mobile/notifications"); return list.notifications
    }
    func markRead(id: String) async throws { let _: Acknowledgement = try await send("/api/mobile/notifications/\(id)/read", method: "POST", body: Data("{}".utf8)) }
    func markAllNotificationsRead() async throws {
        struct ReadResult: Decodable { let read: Bool }
        let result: ReadResult = try await send("/api/mobile/notifications/read-all", method: "POST", body: Data("{}".utf8))
        guard result.read else { throw APIError(status: 0, code: "read_unconfirmed", message: "Notification read status was not confirmed. Refresh Activity to try again.") }
    }
    func setOccurrenceCompletion(_ occurrence: ChoreOccurrence, completed: Bool, mutationID: String) async throws -> ChoreOccurrence {
        struct Change: Encodable { let completed: Bool; let expectedVersion: Int; let mutationId: String }
        return try await send("/api/chore-occurrences/\(occurrence.id)/completion", method: "PUT", body: encoded(Change(completed: completed, expectedVersion: occurrence.version, mutationId: mutationID)))
    }
    func changeOccurrence(_ id: String, action: OccurrenceAction) async throws -> ChoreOccurrence {
        try await send("/api/chore-occurrences/\(id)/actions", method: "POST", body: encoded(action))
    }
    func choreHistory(from: String, to: String, personID: String?) async throws -> [ChoreHistoryItem] {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to), URLQueryItem(name: "limit", value: "100")]
        if let personID { query.queryItems?.append(URLQueryItem(name: "personId", value: personID)) }
        let result: ChoreHistoryResponse = try await send("/api/chore-history?" + (query.percentEncodedQuery ?? "")); return result.history
    }
    func choreBreaks() async throws -> [ChoreBreak] { let result: ChoreBreaksResponse = try await send("/api/chore-exceptions"); return result.exceptions }
    func schoolCalendar(date: String) async throws -> SchoolCalendarResponse { try await send("/api/school-calendar?date=\(date)") }
    func changeSchoolDay(_ draft: SchoolDayOverrideDraft) async throws -> SchoolCalendarResponse { try await send("/api/school-calendar", method: "PATCH", body: encoded(draft)) }
    func createChoreBreak(_ draft: ChoreBreakDraft) async throws -> ChoreBreak { try await send("/api/chore-exceptions", method: "POST", body: encoded(draft)) }
    func revokeChoreBreak(_ item: ChoreBreak, reason: String, mutationID: String) async throws -> ChoreBreak {
        struct Revoke: Encodable { let expectedVersion: Int; let reason: String; let mutationId: String }
        return try await send("/api/chore-exceptions/\(item.id)/revoke", method: "POST", body: encoded(Revoke(expectedVersion: item.version, reason: reason, mutationId: mutationID)))
    }
    func createFrameAccessCode(scope: String, personID: String?) async throws -> FrameAccessCode {
        struct Request: Encodable { let scope: String; let personId: String? }
        return try await send("/api/frame-access-codes", method: "POST", body: encoded(Request(scope: scope, personId: personID)))
    }
    func parentPin(pin: String?) async throws -> ParentPinStatus {
        struct Body: Encodable { let pin: String }
        return try await send("/api/parent-pin", method: pin == nil ? "GET" : "PUT", body: try pin.map { try encoded(Body(pin: $0)) })
    }
    func members() async throws -> [FamilyMember] { let list: FamilyMemberList = try await send("/api/members"); return list.members }
    func changeMemberCapabilities(_ id: String, capabilities: ParentCapabilities) async throws -> MemberCapabilitiesResult {
        try await send("/api/members/\(id)/capabilities", method: "PATCH", body: encoded(capabilities))
    }
    func internet() async throws -> InternetSnapshot { try await send("/api/internet") }
    func requestDeviceAccess(deviceID: String, minutes: Int, reason: String?, mutationID: String) async throws -> DeviceAccessRequest {
        struct Draft: Encodable { let deviceId: String; let minutes: Int; let reason: String?; let mutationId: String }
        return try await send("/api/internet/requests", method: "POST", body: encoded(Draft(deviceId: deviceID, minutes: minutes, reason: reason, mutationId: mutationID)))
    }
    func decideDeviceAccess(_ item: DeviceAccessRequest, approve: Bool, mutationID: String) async throws -> DeviceAccessRequest {
        struct Decision: Encodable { let action: String; let expectedVersion: Int; let mutationId: String }
        return try await send("/api/internet/requests/\(item.id)/decision", method: "POST", body: encoded(Decision(action: approve ? "approve" : "decline", expectedVersion: item.version, mutationId: mutationID)))
    }
    func redeemInternet(creditID: String, deviceID: String, mutationID: String) async throws -> InternetSession {
        try await send("/api/internet/redeem", method: "POST", body: encoded(["creditId": creditID, "deviceId": deviceID, "mutationId": mutationID]))
    }
    func grantInternet(personID: String, deviceID: String, minutes: Int?, allDay: Bool, reason: String?, mutationID: String) async throws -> InternetSession {
        struct Grant: Encodable { let personId: String; let deviceId: String; let minutes: Int?; let allDay: Bool; let reason: String?; let mutationId: String }
        return try await send("/api/internet/grants", method: "POST", body: encoded(Grant(personId: personID, deviceId: deviceID, minutes: minutes, allDay: allDay, reason: reason, mutationId: mutationID)))
    }
    func changeInternetSession(_ id: String, action: InternetSessionAction) async throws -> InternetSession { try await send("/api/internet/sessions/\(id)/actions", method: "POST", body: encoded(action)) }
    func changeDeviceAccess(_ device: ManagedInternetDevice, access: String, mutationID: String) async throws -> ManagedInternetDevice {
        struct Control: Encodable { let access: String; let expectedVersion: Int; let mutationId: String }
        return try await send("/api/internet/devices/\(device.id)/access", method: "POST", body: encoded(Control(access: access, expectedVersion: device.version, mutationId: mutationID)))
    }
    func saveInternetDevice(_ draft: ManagedDeviceDraft, id: String?) async throws -> ManagedInternetDevice {
        try await send(id.map { "/api/internet/devices/\($0)" } ?? "/api/internet/devices", method: id == nil ? "POST" : "PATCH", body: encoded(draft))
    }
    func deleteInternetDevice(_ item: ManagedInternetDevice, mutationID: String) async throws {
        let _: Acknowledgement = try await send("/api/internet/devices/\(item.id)?expectedVersion=\(item.version)&mutationId=\(mutationID)", method: "DELETE")
    }
    func saveInternetPolicy(_ personID: String, draft: RewardPolicyDraft) async throws -> RewardPolicy { try await send("/api/internet/policies/\(personID)", method: "PUT", body: encoded(draft)) }
    func resolveInternetCredit(_ id: String, action: String, reason: String, mutationID: String) async throws -> RewardCredit {
        try await send("/api/internet/credits/\(id)/resolve", method: "POST", body: encoded(["action": action, "reason": reason, "mutationId": mutationID]))
    }
    func internetHistory() async throws -> [InternetHistoryItem] { let list: InternetHistoryList = try await send("/api/internet/history"); return list.history }
    func deleteAccount(password: String) async throws {
        struct Deleted: Decodable { let deleted: Bool }
        var authorization: String?
        if mobileToken == nil {
            // Verified unlinked onboarding retains only the first-party BFF
            // cookie. Exchange it for identity proof without joining a family
            // or issuing a mobile credential, as with normal account exchange.
            struct AuthToken: Decodable { let token: String }
            let proof: AuthToken = try await send("/api/auth/token", wrapped: false, authenticated: false)
            authorization = "Bearer \(proof.token)"
        }
        let result: Deleted = try await send("/api/account/delete", method: "POST", body: encoded(["password": password, "confirmation": "DELETE MY ACCOUNT"]), authorization: authorization)
        guard result.deleted else { throw APIError(status: 0, code: "deletion_unconfirmed", message: "Account deletion was not confirmed. Sign in again to check your account before retrying.") }
        clearLoginCookies()
    }
    func transferOwnership(userID: String) async throws {
        struct Transferred: Decodable { let transferred: Bool; let userId: String }
        let result: Transferred = try await send("/api/account/transfer-ownership", method: "POST", body: encoded(["userId": userID]))
        guard result.transferred, result.userId == userID else { throw APIError(status: 0, code: "transfer_unconfirmed", message: "Ownership transfer was not confirmed. Refresh family access before trying again.") }
    }

    func locationHistory() async throws -> LocationHistorySummary { try await send("/api/locations/history") }
    func changeLocationHistory(_ draft:LocationHistoryDraft) async throws -> LocationHistoryChange { try await send("/api/locations/history",method:"PUT",body:encoded(draft)) }
    func deleteLocationHistory() async throws { let _: [String:Bool] = try await send("/api/locations/history",method:"DELETE") }
    func parentLocations() async throws -> ParentLocationSnapshot { try await send("/api/locations") }
    func changeLocationSharing(_ draft: LocationSharingDraft) async throws -> LocationSharingResult { try await send("/api/locations/sharing", method:"PUT", body:encoded(draft)) }
    func mediaList() async throws -> MediaList { try await send("/api/media") }
    func uploadPhoto(id: String, data: Data) async throws -> FamilyMedia {
        let result: MediaResult = try await send("/api/media/\(id)", method: "PUT", body: data, contentType: "image/jpeg"); return result.media
    }
    func reserveVideo(id: String, draft: VideoDraft) async throws -> VideoReservation { try await send("/api/media/\(id)/video", method: "POST", body: encoded(draft)) }
    func finishVideo(id: String) async throws -> FamilyMedia { let result: MediaResult = try await send("/api/media/\(id)/complete", method: "POST"); return result.media }
    func removeMedia(id: String) async throws { let _: Acknowledgement = try await send("/api/media/\(id)", method: "DELETE") }
    nonisolated static func mediaURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https", url.host?.hasSuffix(".supabase.co") == true,
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              url.path.hasPrefix("/storage/v1/object/") else { return nil }; return url
    }
    func uploadVideo(file: URL, signedURL: String) async throws {
        guard let url = Self.mediaURL(signedURL) else { throw MediaPreparation.invalid("The upload link is invalid.") }
        var request = URLRequest(url: url); request.httpMethod = "PUT"; request.timeoutInterval = 300
        request.setValue("video/mp4", forHTTPHeaderField: "Content-Type"); request.setValue("0", forHTTPHeaderField: "cache-control")
        // Deliberately no FamilyMobile Authorization header on a Storage request.
        let (_, response) = try await mediaSession.upload(for: request, fromFile: file)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw APIError(status: 503, code: "video_upload_failed", message: "The video upload did not finish. Refresh the collection before trying again.") }
    }
    func mediaPhoto(id: String) async throws -> Data {
        let link: MediaDownload = try await send("/api/media/\(id)/content")
        guard let url = Self.mediaURL(link.url) else { throw MediaPreparation.invalid("The photo link is invalid.") }
        let (data, response) = try await session.data(for: URLRequest(url: url))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= 3_000_000,
              http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("image/jpeg") == true else { throw MediaPreparation.invalid("The photo preview could not be loaded.") }
        return data
    }

}
