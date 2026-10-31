import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
import AVFoundation
import ImageIO
import CryptoKit

struct FamilyMedia: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let bytes: Int
    let width: Int
    let height: Int
    let duration: Double?
    let createdAt: String
}
struct MediaList: Decodable { let media: [FamilyMedia]; let maxBytes: Int; let maxItems: Int }
struct MediaResult: Decodable { let media: FamilyMedia }
struct VideoReservation: Decodable { let media: FamilyMedia; let uploadURL: String? }
struct VideoDraft: Encodable { let bytes: Int; let width: Int; let height: Int; let duration: Double; let fingerprint: String }
struct MediaDownload: Decodable { let url: String }

extension FamilyAPI {
    func mediaList() async throws -> MediaList { throw APIError(status: 503, code: "unsupported", message: "The media collection is unavailable.") }
    func uploadPhoto(id: String, data: Data) async throws -> FamilyMedia { throw APIError(status: 503, code: "unsupported", message: "Photo upload is unavailable.") }
    func reserveVideo(id: String, draft: VideoDraft) async throws -> VideoReservation { throw APIError(status: 503, code: "unsupported", message: "Video upload is unavailable.") }
    func uploadVideo(file: URL, signedURL: String) async throws { throw APIError(status: 503, code: "unsupported", message: "Video upload is unavailable.") }
    func finishVideo(id: String) async throws -> FamilyMedia { throw APIError(status: 503, code: "unsupported", message: "Video upload is unavailable.") }
    func removeMedia(id: String) async throws { throw APIError(status: 503, code: "unsupported", message: "Media removal is unavailable.") }
    func mediaPhoto(id: String) async throws -> Data { throw APIError(status: 503, code: "unsupported", message: "Photo preview is unavailable.") }
}

struct PickedMedia: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in try copy(received.file, fallbackExtension: "jpg") }
        FileRepresentation(importedContentType: .movie) { received in try copy(received.file, fallbackExtension: "mov") }
    }
    static func copy(_ source: URL, fallbackExtension: String) throws -> Self {
        // AVFoundation uses the container extension when opening local movies.
        // A generic .source suffix makes valid MOV/MP4 clips fail with -11828.
        let suffix = source.pathExtension.isEmpty ? fallbackExtension : source.pathExtension
        let target = MediaPreparation.temporary(suffix)
        try FileManager.default.copyItem(at: source, to: target)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
        return Self(url: target)
    }
}
struct PreparedMedia {
    let url: URL
    let bytes: Int
    let width: Int
    let height: Int
    let duration: Double?
    let fingerprint: String
}
enum MediaPreparation {
    static func photo(_ source: URL) throws -> PreparedMedia {
        guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1920] as CFDictionary) else { throw invalid("This photo could not be read.") }
        let url = temporary("jpg")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw invalid("This photo could not be prepared.") }
        // Re-encode pixels only: original EXIF/location metadata is not copied.
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { try? FileManager.default.removeItem(at: url); throw invalid("This photo could not be prepared.") }
        let bytes = try size(url)
        guard bytes <= 3_000_000 else { try? FileManager.default.removeItem(at: url); throw invalid("Choose a smaller photo.") }
        return PreparedMedia(url: url, bytes: bytes, width: image.width, height: image.height, duration: nil, fingerprint: try hash(url))
    }
    static func video(_ source: URL) async throws -> PreparedMedia {
        let asset = AVURLAsset(url: source), duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= 300 else { throw invalid("Trim this video to five minutes or less before adding it.") }
        for preset in [AVAssetExportPreset1920x1080, AVAssetExportPreset1280x720, AVAssetExportPreset960x540] {
            try Task.checkCancellation()
            let url = temporary("mp4")
            guard let export = AVAssetExportSession(asset: asset, presetName: preset) else { throw invalid("This video could not be prepared.") }
            export.outputURL = url; export.outputFileType = .mp4; export.shouldOptimizeForNetworkUse = true; export.metadata = []
            await withTaskCancellationHandler(operation: {
                await withCheckedContinuation { continuation in export.exportAsynchronously { continuation.resume() } }
            }, onCancel: { export.cancelExport() })
            guard export.status == .completed else { try? FileManager.default.removeItem(at: url); try Task.checkCancellation(); throw invalid("This video could not be prepared. Try another clip.") }
            let bytes = try size(url)
            if bytes > 52_428_800 { try? FileManager.default.removeItem(at: url); continue }
            let output = AVURLAsset(url: url)
            guard let track = try await output.loadTracks(withMediaType: .video).first else { try? FileManager.default.removeItem(at: url); throw invalid("This clip has no video track.") }
            let dimensions = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform)
            let rect = CGRect(origin: .zero, size: dimensions).applying(transform)
            return PreparedMedia(url: url, bytes: bytes, width: Int(abs(rect.width).rounded()), height: Int(abs(rect.height).rounded()), duration: duration, fingerprint: try hash(url))
        }
        throw invalid("This video is larger than 50 MB after compression. Trim it and try again.")
    }
    static func invalid(_ message: String) -> APIError { APIError(status: 422, code: "invalid_media", message: message) }
    static func temporary(_ ext: String) -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("family-media-\(UUID().uuidString).\(ext)") }
    static func size(_ url: URL) throws -> Int { try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0 }
    static func hash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }; var digest = SHA256()
        while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty { digest.update(data: chunk) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor final class MediaLibraryModel: ObservableObject {
    @Published private(set) var items: [FamilyMedia] = []
    @Published private(set) var busy = false
    @Published private(set) var progress: String?
    @Published private(set) var message: String?
    var authenticationFailed: ((String) async -> Void)?
    private let api: any FamilyAPI
    private var principal: MobileSession?
    private var generation = 0
    private var revision = 0
    private var task: Task<Void, Never>?
    init(api: any FamilyAPI) { self.api = api }
    func bind(_ session: MobileSession?) {
        if session?.cacheIdentity == principal?.cacheIdentity && session?.role == principal?.role { principal = session; return }
        generation += 1; task?.cancel(); task = nil; principal = session; items = []; busy = false; message = nil; progress = nil
    }
    func refresh() async {
        guard principal != nil else { return }; let epoch = generation, readRevision = revision
        do { let result = try await api.mediaList(); guard epoch == generation, readRevision == revision else { return }; items = result.media }
        catch { await failure(error, epoch: epoch) }
    }
    func image(_ id: String) async -> UIImage? {
        let epoch = generation
        do { let data = try await api.mediaPhoto(id: id); guard epoch == generation else { return nil }; guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
            let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 320] as CFDictionary) else { return nil }; return UIImage(cgImage: thumbnail) }
        catch { await failure(error, epoch: epoch); return nil }
    }
    func remove(_ item: FamilyMedia) async {
        guard principal?.isAdmin == true, !busy else { return }; let epoch = generation; revision += 1; busy = true; message = nil
        defer { if epoch == generation { busy = false } }
        do { try await api.removeMedia(id: item.id); guard epoch == generation else { return }; revision += 1; items.removeAll { $0.id == item.id } }
        catch { await failure(error, epoch: epoch) }
    }
    func add(_ selection: [PhotosPickerItem]) {
        guard principal?.isAdmin == true, !busy, !selection.isEmpty else { return }
        let epoch = generation; revision += 1; busy = true; message = nil
        task = Task { [weak self] in
            guard let self else { return }; var completed = 0, failures = 0
            defer { if epoch == generation { busy = false; progress = nil; task = nil } }
            for (index, item) in selection.enumerated() {
                guard epoch == generation, !Task.isCancelled else { return }
                progress = "Preparing \(index + 1) of \(selection.count)…"
                do {
                    guard let picked = try await item.loadTransferable(type: PickedMedia.self) else { throw MediaPreparation.invalid("This item could not be opened.") }
                    defer { try? FileManager.default.removeItem(at: picked.url) }
                    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
                    let prepared = try await Task.detached { isVideo ? try await MediaPreparation.video(picked.url) : try MediaPreparation.photo(picked.url) }.value
                    defer { try? FileManager.default.removeItem(at: prepared.url) }
                    guard epoch == generation, !Task.isCancelled else { return }
                    progress = "Uploading \(index + 1) of \(selection.count)…"
                    let id = UUID().uuidString.lowercased(), saved: FamilyMedia
                    if let duration = prepared.duration {
                        let reservation = try await api.reserveVideo(id: id, draft: VideoDraft(bytes: prepared.bytes, width: prepared.width, height: prepared.height, duration: duration, fingerprint: prepared.fingerprint))
                        guard epoch == generation, !Task.isCancelled else { return }
                        if let url = reservation.uploadURL { try await api.uploadVideo(file: prepared.url, signedURL: url) }
                        guard epoch == generation, !Task.isCancelled else { return }
                        saved = try await api.finishVideo(id: id)
                    } else { saved = try await api.uploadPhoto(id: id, data: Data(contentsOf: prepared.url)) }
                    guard epoch == generation else { return }; revision += 1; if !items.contains(where: { $0.id == saved.id }) { items.append(saved) }; completed += 1
                } catch {
                    guard epoch == generation, !Task.isCancelled else { return }; failures += 1
                    await failure(error, epoch: epoch)
                    if (error as? APIError)?.isAuthenticationFailure == true { return }
                }
            }
            guard epoch == generation else { return }
            let detail = message
            await refresh()
            guard epoch == generation else { return }
            message = failures == 0 ? "Added \(completed) \(completed == 1 ? "item" : "items") to your frame collection." : "Added \(completed); \(failures) could not be added. \(detail ?? "Try those items again.")"
        }
    }
    private func failure(_ error: Error, epoch: Int) async {
        guard epoch == generation else { return }
        if let failure = error as? APIError, failure.isAuthenticationFailure { await authenticationFailed?(failure.message) }
        else if !(error is CancellationError) { message = error.localizedDescription }
    }
}

struct MediaLibraryScreen: View {
    @EnvironmentObject var model: AppModel
    var body: some View { MediaLibraryContent(library: model.media, canManage: model.isAdmin) }
}
private struct MediaLibraryContent: View {
    @ObservedObject var library: MediaLibraryModel
    let canManage: Bool
    @State private var selection: [PhotosPickerItem] = []
    @State private var removal: FamilyMedia?
    var body: some View {
        List {
            Section {
                Text("Your family’s moments, on the big screen.").font(.title2.bold())
                Text("Photos stay for 20 seconds. Videos play to the end, starting muted each time the frame goes idle. The frame keeps a private local copy for smooth playback.").font(.subheadline).foregroundStyle(Brand.muted)
                if canManage {
                    PhotosPicker(selection: $selection, maxSelectionCount: 20, matching: .any(of: [.images, .videos]), photoLibrary: .shared()) {
                        Label("Add photos and videos", systemImage: "plus.circle.fill")
                    }.disabled(library.busy)
                    Text("Up to 200 items / 1 GB. Videos: up to 5 minutes and 50 MB after preparation.").font(.caption).foregroundStyle(Brand.muted)
                }
                if let progress = library.progress { HStack { ProgressView(); Text(progress) } }
                if let message = library.message { Text(message).font(.subheadline).accessibilityIdentifier("media-message") }
            }
            Section("Collection · \(library.items.count)") {
                if library.items.isEmpty { ContentUnavailableView("Your moments belong here", systemImage: "photo.on.rectangle.angled", description: Text(canManage ? "Add a few favorites to start your frame collection." : "Your household administrator can add photos and videos.")) }
                ForEach(library.items) { item in
                    HStack(spacing: 14) {
                        MediaThumbnail(item: item, library: library).frame(width: 76, height: 58).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading) {
                            Text(item.kind == "video" ? "Family video" : "Family photo").font(.headline)
                            Text(item.duration.map { "\(Int($0)) seconds · " } ?? "", comment: "Video length") + Text(ByteCountFormatter.string(fromByteCount: Int64(item.bytes), countStyle: .file))
                        }.font(.caption).foregroundStyle(Brand.muted)
                        Spacer()
                        if canManage { Button(role: .destructive) { removal = item } label: { Image(systemName: "trash") }.buttonStyle(.borderless).disabled(library.busy).accessibilityLabel("Remove \(item.kind)") }
                    }.padding(.vertical, 4)
                }
            }
        }.navigationTitle("Photos & videos").scrollContentBackground(.hidden).background(Brand.background)
            .task { await library.refresh() }.refreshable { await library.refresh() }
            .onChange(of: selection) { _, value in if !value.isEmpty { library.add(value); selection = [] } }
            .confirmationDialog("Remove this item from the family frame collection?", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }), titleVisibility: .visible) {
                Button("Remove from collection", role: .destructive) { if let item = removal { Task { await library.remove(item) } }; removal = nil }
            }
    }
}
private struct MediaThumbnail: View {
    let item: FamilyMedia
    @ObservedObject var library: MediaLibraryModel
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            Brand.background
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: item.kind == "video" ? "play.rectangle.fill" : "photo").font(.title2).foregroundStyle(Brand.muted) }
        }.task(id: item.id) { if item.kind == "photo" { image = await library.image(item.id) } }
    }
}
