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
    func joinFamily(invitation: String) async throws -> AccountOutcome
    func cancelAccountOnboarding() async
    func serviceStatus() async throws -> MobileServiceStatus
    func currentSession() async throws -> MobileSession
    func signOut() async throws
    func household(date: String) async throws -> HouseholdSnapshot
    func calendar(from: String, to: String) async throws -> CalendarSnapshot
    func setCompletion(_ chore: Chore, date: String, completed: Bool, mutationID: String) async throws -> CompletionResult
    func saveChore(_ draft: ChoreDraft, id: String?) async throws
    func deleteChore(_ chore: Chore) async throws
    func createChildInvitation(personID: String, email: String) async throws -> ChildInvitation
    func devices() async throws -> [MobileDevice]
    func revokeDevice(id: String) async throws
    func registerPush(token: String, environment: String, installationID: String) async throws
    func preferences() async throws -> NotificationPreferences
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences
    func notifications() async throws -> [FamilyNotification]
    func markRead(id: String) async throws
}

@MainActor
final class APIClient: FamilyAPI {
    let baseURL: URL
    private let session: URLSession
    private let redirectDelegate = NoRedirectDelegate()
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
                                     authorization: String? = nil, wrapped: Bool = true, authenticated: Bool = true) async throws -> T {
        guard path.hasPrefix("/api/"), !path.contains(".."), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.host == baseURL.host, url.scheme == baseURL.scheme else {
            throw APIError(status: 0, code: "invalid_endpoint", message: "The app configuration is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body
        request.mainDocumentURL = baseURL
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
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
    func preferences() async throws -> NotificationPreferences { try await send("/api/mobile/notification-preferences") }
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences {
        try await send("/api/mobile/notification-preferences", method: "PUT", body: encoded(prefs))
    }
    func notifications() async throws -> [FamilyNotification] {
        let list: NotificationList = try await send("/api/mobile/notifications"); return list.notifications
    }
    func markRead(id: String) async throws { let _: Acknowledgement = try await send("/api/mobile/notifications/\(id)/read", method: "POST", body: Data("{}".utf8)) }
}
