import SwiftUI
import CoreLocation
import Security

struct ParentLocationSharing: Codable, Equatable {
    let enabled: Bool
    let version: Int
    let label: String
    let thisPhone: Bool
    static let off = Self(enabled: false, version: 0, label: "", thisPhone: false)
}
struct ParentLocationSnapshot: Decodable { let sharing: ParentLocationSharing }
struct LocationSharingResult: Decodable { let sharing: ParentLocationSharing; let reportToken: String? }
struct LocationSharingDraft: Encodable { let enabled: Bool; let label: String; let expectedVersion: Int }
struct LocationPoint: Encodable { let latitude: Double; let longitude: Double; let accuracy: Double; let place: String; let recordedAt: String }
struct LocationReportCredential: Codable {
    let token: String
    let identity: String
    var stopping: Bool = false
}
extension FamilyAPI {
    func parentLocations() async throws -> ParentLocationSnapshot { throw APIError(status: 503, code: "unsupported", message: "Location sharing is unavailable.") }
    func changeLocationSharing(_ draft: LocationSharingDraft) async throws -> LocationSharingResult { throw APIError(status: 503, code: "unsupported", message: "Location sharing is unavailable.") }
}

// Only this narrow write/stop credential is available while the screen is locked.
// The full household session keeps its existing WhenUnlocked protection.
struct LocationCredentialStore {
    private let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"com.swerved.familyframe.location-report", kSecAttrAccount as String:"current"]
    func load() throws -> LocationReportCredential? {
        var q=query; q[kSecReturnData as String]=true; q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result: CFTypeRef?; let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data=result as? Data else { throw StorageError.keychain }
        return try JSONDecoder().decode(LocationReportCredential.self,from:data)
    }
    func save(_ value: LocationReportCredential) throws {
        let attributes:[String:Any]=[kSecValueData as String:try JSONEncoder().encode(value),kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status=SecItemUpdate(query as CFDictionary,attributes as CFDictionary)
        if status == errSecItemNotFound { var q=query;attributes.forEach{q[$0.key]=$0.value};guard SecItemAdd(q as CFDictionary,nil)==errSecSuccess else{throw StorageError.keychain} }
        else if status != errSecSuccess { throw StorageError.keychain }
    }
    func clear() throws { let status=SecItemDelete(query as CFDictionary);guard status == errSecSuccess || status == errSecItemNotFound else{throw StorageError.keychain} }
}
private final class LocationNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor protocol LocationReporting: AnyObject {
    func activate(token:String,identity:String) throws
    func bind(_ session:MobileSession?)
    func stop(sendNow:Bool)
    func forgetConfirmedStop()
    func requestAlways()
}
@MainActor final class ParentLocationReporter: NSObject, ObservableObject, CLLocationManagerDelegate, LocationReporting {
    static let shared = ParentLocationReporter()
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var message: String?
    @Published private(set) var lastSent: Date?
    private let manager = CLLocationManager(), geocoder = CLGeocoder(), store = LocationCredentialStore()
    private let redirect = LocationNoRedirect()
    private lazy var network: URLSession = {
        let config=URLSessionConfiguration.ephemeral;config.urlCache=nil;config.httpCookieStorage=nil;config.timeoutIntervalForRequest=25
        return URLSession(configuration:config,delegate:redirect,delegateQueue:nil)
    }()
    private var credential: LocationReportCredential?
    private var sending = false, started = false
    private var lastAttempt = Date.distantPast
    private var lastPlaceLocation: CLLocation?, place = ""
    private var generation = 0
    override init() {
        super.init();manager.delegate=self;authorization=manager.authorizationStatus
        manager.desiredAccuracy=kCLLocationAccuracyHundredMeters;manager.distanceFilter=100
        manager.pausesLocationUpdatesAutomatically=true;manager.showsBackgroundLocationIndicator=true
    }
    func resume() {
        do { credential=try store.load();configure() } catch { message=error.localizedDescription }
    }
    func requestPermission() { manager.requestWhenInUseAuthorization() }
    func requestAlways() { manager.requestAlwaysAuthorization() }
    func activate(token:String,identity:String) throws {
        let value=LocationReportCredential(token:token,identity:identity)
        try store.save(value);generation += 1;credential=value;message=nil;lastAttempt = .distantPast;configure()
    }
    func bind(_ session:MobileSession?) {
        guard let saved=credential else { return }
        if session?.cacheIdentity != saved.identity || session?.isChild == true { stop() }
    }
    func stop(sendNow:Bool = true) {
        generation += 1;manager.stopUpdatingLocation();manager.stopMonitoringSignificantLocationChanges();started=false
        guard var saved=credential else { return };saved.stopping=true;credential=saved
        do { try store.save(saved) } catch { message=error.localizedDescription }
        if sendNow {Task { await sendStop() }}
    }
    func forgetConfirmedStop() {
        generation += 1;manager.stopUpdatingLocation();manager.stopMonitoringSignificantLocationChanges();started=false;credential=nil
        try? store.clear()
    }
    private func sendStop() async {
        guard let saved=credential,saved.stopping else{return}
        do { try await send(saved,method:"DELETE",point:nil);if credential?.token==saved.token {forgetConfirmedStop();message="Location sharing stopped."} }
        catch let error as APIError where error.status==401 { if credential?.token==saved.token {forgetConfirmedStop()} }
        catch {message="Sharing stopped on this phone. Reconnect to remove the last shared location; it expires after 24 hours."}
    }
    private func configure() {
        authorization=manager.authorizationStatus
        guard let saved=credential else{return}
        if saved.stopping { Task {await sendStop()};return }
        guard authorization == .authorizedAlways || authorization == .authorizedWhenInUse else {
            if authorization == .denied || authorization == .restricted {stop()};return
        }
        manager.allowsBackgroundLocationUpdates=authorization == .authorizedAlways
        if !started { started=true;manager.startUpdatingLocation();if CLLocationManager.significantLocationChangeMonitoringAvailable(){manager.startMonitoringSignificantLocationChanges()} }
    }
    nonisolated func locationManagerDidChangeAuthorization(_ manager:CLLocationManager) { Task { @MainActor in self.configure() } }
    nonisolated func locationManager(_ manager:CLLocationManager,didFailWithError error:Error) {
        if (error as? CLError)?.code != .locationUnknown {Task { @MainActor in self.message="Waiting for an available phone location."}}
    }
    nonisolated func locationManager(_ manager:CLLocationManager,didUpdateLocations locations:[CLLocation]) {
        Task { @MainActor in self.receive(locations) }
    }
    private func receive(_ locations:[CLLocation]) {
        guard let location=locations.last,location.horizontalAccuracy>=0,abs(location.timestamp.timeIntervalSinceNow)<900,
              let saved=credential,!saved.stopping,!sending,Date().timeIntervalSince(lastAttempt)>30 else{return}
        lastAttempt=Date();sending=true;let epoch=generation
        Task {
            var background=UIBackgroundTaskIdentifier.invalid
            background=UIApplication.shared.beginBackgroundTask(withName:"Share parent location") { if background != .invalid {UIApplication.shared.endBackgroundTask(background);background = .invalid} }
            defer {sending=false;if background != .invalid {UIApplication.shared.endBackgroundTask(background)}}
            do {
                if lastPlaceLocation == nil || location.distance(from:lastPlaceLocation!)>250 {
                    if let address=try? await geocoder.reverseGeocodeLocation(location).first {
                        place=[address.subLocality,address.locality,address.administrativeArea].compactMap{$0}.uniqued().joined(separator:", ")
                        lastPlaceLocation=location
                    } else {place=""}
                }
                guard epoch==generation,credential?.token==saved.token,!saved.stopping else{return}
                let point=LocationPoint(latitude:location.coordinate.latitude,longitude:location.coordinate.longitude,accuracy:location.horizontalAccuracy,place:String(place.prefix(160)),recordedAt:ISO8601DateFormatter().string(from:location.timestamp))
                try await send(saved,method:"POST",point:point)
                guard epoch==generation else{return};lastSent=Date();message=nil
            } catch let error as APIError where error.status==401 {if epoch==generation {forgetConfirmedStop();message="Sharing ended. Enable it again to share this phone."}}
            catch {if epoch==generation {message="Waiting for a connection to share the next location."}}
        }
    }
    private func send(_ saved:LocationReportCredential,method:String,point:LocationPoint?) async throws {
        var request=URLRequest(url:APIClient.configuredURL.appendingPathComponent("api/location-reports"));request.httpMethod=method
        request.setValue(APIClient.configuredURL.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
        request.setValue("FamilyLocation \(saved.token)",forHTTPHeaderField:"Authorization");request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try point.map{try JSONEncoder().encode($0)} ?? Data("{}".utf8)
        let (_,response)=try await network.data(for:request)
        guard let http=response as? HTTPURLResponse,(200..<300).contains(http.statusCode) else{throw APIError(status:(response as? HTTPURLResponse)?.statusCode ?? 0,code:"location_report_failed",message:"The location update was not confirmed.")}
    }
}
private extension Array where Element: Hashable { func uniqued()->[Element] {var seen=Set<Element>();return filter{seen.insert($0).inserted}} }

@MainActor final class ParentLocationModel: ObservableObject {
    @Published private(set) var sharing=ParentLocationSharing.off
    @Published private(set) var busy=false
    @Published var message:String?
    private let api:any FamilyAPI
    private let reporter:any LocationReporting
    private var session:MobileSession?,generation=0,revision=0
    init(api:any FamilyAPI,reporter:(any LocationReporting)? = nil){self.api=api;self.reporter=reporter ?? ParentLocationReporter.shared}
    func bind(_ value:MobileSession?) {
        if session?.cacheIdentity != value?.cacheIdentity {generation += 1;sharing = .off;message=nil;busy=false}
        session=value;reporter.bind(value)
    }
    func refresh() async {
        guard session != nil,session?.isChild != true else{return};let epoch=generation,readRevision=revision
        do {let result=try await api.parentLocations();guard epoch==generation,readRevision==revision else{return};sharing=result.sharing
            if !sharing.enabled || !sharing.thisPhone {reporter.forgetConfirmedStop()}
        } catch {if epoch==generation {message=error.localizedDescription}}
    }
    func change(enabled:Bool,label:String) async {
        guard let session,!session.isChild,!busy else{return};let epoch=generation;revision += 1;busy=true;message=nil
        defer {if epoch==generation {busy=false}}
        if !enabled {reporter.stop(sendNow:false)}
        do {
            // Read the latest consent version, including a completed scoped stop.
            let current=try await api.parentLocations();guard epoch==generation else{return}
            let result=try await api.changeLocationSharing(LocationSharingDraft(enabled:enabled,label:label.isEmpty ? session.user.name : label,expectedVersion:current.sharing.version))
            guard epoch==generation else{return};sharing=result.sharing
            if enabled,let token=result.reportToken {
                do {try reporter.activate(token:token,identity:session.cacheIdentity);reporter.requestAlways()}
                catch {
                    let stopped=try await api.changeLocationSharing(LocationSharingDraft(enabled:false,label:result.sharing.label,expectedVersion:result.sharing.version))
                    if epoch==generation {sharing=stopped.sharing;message="This phone could not save location sharing. Please try again."}
                }
            } else {reporter.forgetConfirmedStop()}
        } catch {if epoch==generation {message=error.localizedDescription;await refresh()}}
    }
}
struct ParentLocationSettings: View {
    @EnvironmentObject var model:AppModel
    var body:some View {ParentLocationSettingsContent(location:model.locations)}
}
private struct ParentLocationSettingsContent: View {
    @ObservedObject var location:ParentLocationModel
    @ObservedObject private var reporter=ParentLocationReporter.shared
    @State private var label=""
    private var allowed:Bool {reporter.authorization == .authorizedAlways || reporter.authorization == .authorizedWhenInUse}
    var body:some View {
        Form {
            Section {
                Text("Share where you are with your family.").font(.title2.bold())
                Text("Your household’s members and paired frames can see your latest location, place name, accuracy and update time. This shares only your phone’s location. Each parent chooses for themselves; child location sharing is not supported.")
                Text("Only the latest point is kept. It disappears after 24 hours without an update. You can stop sharing at any time.").font(.footnote).foregroundStyle(Brand.muted)
            }
            Section("Your map name") {TextField("Mom, Dad, or your name",text:$label).disabled(location.busy)}
            Section("This phone") {
                LabeledContent("Location access",value:reporter.authorization == .authorizedAlways ? "Always" : allowed ? "While Using" : "Not enabled")
                if !allowed {Button("Allow location access") {reporter.requestPermission()}}
                if allowed && reporter.authorization != .authorizedAlways {Button("Allow Always access") {reporter.requestAlways()};Text("Choose Always to update the family frame while this app is in the background. If iOS does not show a prompt, use Settings → Family Frame → Location → Always.").font(.footnote)}
                Button {Task {await location.change(enabled:true,label:label)}} label:{Text(location.sharing.enabled ? "Share from this phone" : "Start sharing my location")}.disabled(!allowed || location.busy || label.trimmingCharacters(in:.whitespaces).isEmpty)
                if location.sharing.enabled {Button("Stop sharing my location",role:.destructive){Task{await location.change(enabled:false,label:label)}}.disabled(location.busy)}
                Button("Open iOS Settings") {if let url=URL(string:UIApplication.openSettingsURLString){UIApplication.shared.open(url)}}
                if let date=reporter.lastSent {LabeledContent("Last sent",value:date.formatted(date:.omitted,time:.shortened))}
                if let message=location.message ?? reporter.message {Text(message).font(.footnote)}
            }
            Section {Text("Updates depend on iOS, movement, GPS and connectivity. Force-quitting the app can pause updates. The frame always shows when the last update arrived.").font(.footnote).foregroundStyle(Brand.muted)}
        }.navigationTitle("Location sharing").task {await location.refresh();label=location.sharing.label}
    }
}
