import XCTest
import UIKit
import ImageIO
import AVFoundation
import UniformTypeIdentifiers
@testable import FamilyFrame

@MainActor final class MediaLibraryTests: XCTestCase {
    private func fixture() -> (MediaLibraryModel, DashboardAPI, MobileSession) {
        let home = Household(id: "test-home", title: "Synthetic family", timezone: "America/Denver")
        let session = MobileSession(authenticated: true, authType: "mobile", role: "admin", household: home, user: FamilyUser(id: "parent", name: "Parent", email: nil), personId: nil)
        let api = DashboardAPI(session: session, data: HouseholdSnapshot(household: home, role: "admin", date: "2026-10-31", people: [], chores: []))
        let model = MediaLibraryModel(api: api); model.bind(session); return (model, api, session)
    }
    private let photo = FamilyMedia(id: "11111111-1111-4111-8111-111111111111", kind: "photo", bytes: 100, width: 20, height: 20, duration: nil, createdAt: "2026-10-31T18:00:00Z")
    func testLateMediaReadCannotRestoreSignedOutCollection() async {
        let (model, api, _) = fixture(), deferred = Deferred<MediaList>()
        api.mediaHandler = { try await deferred.wait() }
        let read = Task { await model.refresh() }
        while !deferred.waiting { await Task.yield() }
        model.bind(nil)
        deferred.resolve(MediaList(media: [photo], maxBytes: 1000, maxItems: 200)); await read.value
        XCTAssertTrue(model.items.isEmpty)
    }
    func testRemovalCannotBeUndoneByAnOlderListResponse() async {
        let (model, api, _) = fixture()
        api.mediaHandler = { MediaList(media: [self.photo], maxBytes: 1000, maxItems: 200) }
        await model.refresh(); XCTAssertEqual(model.items.count, 1)
        let deferred = Deferred<MediaList>(); api.mediaHandler = { try await deferred.wait() }
        let read = Task { await model.refresh() }; while !deferred.waiting { await Task.yield() }
        await model.remove(photo); deferred.resolve(MediaList(media: [photo], maxBytes: 1000, maxItems: 200)); await read.value
        XCTAssertTrue(model.items.isEmpty)
    }
    func testImportedMOVAndMP4RemainReadableAndPrepareForFrame() async throws {
        for suffix in ["mov", "mp4"] {
            let source = MediaPreparation.temporary(suffix)
            defer { try? FileManager.default.removeItem(at: source) }
            let writer = try AVAssetWriter(outputURL: source, fileType: suffix == "mov" ? .mov : .mp4)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180])
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180])
            writer.add(input); XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: .zero)
            var buffer: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_32ARGB, nil, &buffer), kCVReturnSuccess)
            let pixels = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pixels, [])
            memset(CVPixelBufferGetBaseAddress(pixels), 128, CVPixelBufferGetDataSize(pixels))
            CVPixelBufferUnlockBaseAddress(pixels, [])
            for frame in 0..<3 {
                while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 10_000_000) }
                XCTAssertTrue(adaptor.append(pixels, withPresentationTime: CMTime(value: Int64(frame), timescale: 2)))
            }
            input.markAsFinished(); await writer.finishWriting(); XCTAssertEqual(writer.status, .completed)
            let picked = try PickedMedia.copy(source, fallbackExtension: "mov")
            defer { try? FileManager.default.removeItem(at: picked.url) }
            // The Photos provider can discard its original immediately after transfer.
            try FileManager.default.removeItem(at: source)
            let prepared = try await MediaPreparation.video(picked.url)
            defer { try? FileManager.default.removeItem(at: prepared.url) }
            XCTAssertEqual(picked.url.pathExtension, suffix)
            XCTAssertEqual(prepared.url.pathExtension, "mp4")
            XCTAssertGreaterThan(prepared.duration ?? 0, 0); XCTAssertGreaterThan(prepared.bytes, 0)
            XCTAssertLessThan(prepared.bytes, 52_428_800)
            let tracks = try await AVURLAsset(url: prepared.url).loadTracks(withMediaType: .video)
            XCTAssertEqual(tracks.count, 1)
            let formats = try await XCTUnwrap(tracks.first).load(.formatDescriptions)
            XCTAssertEqual(CMFormatDescriptionGetMediaSubType(try XCTUnwrap(formats.first)), kCMVideoCodecType_H264)
        }
    }
    func testPhotoPreparationResizesAndDropsLocationMetadata() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1800)).image { context in UIColor.purple.setFill(); context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1800)) }
        let source = MediaPreparation.temporary("jpg")
        defer { try? FileManager.default.removeItem(at: source) }
        let destination = CGImageDestinationCreateWithURL(source as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 40, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 105, kCGImagePropertyGPSLongitudeRef: "W"]] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let prepared = try MediaPreparation.photo(source); defer { try? FileManager.default.removeItem(at: prepared.url) }
        XCTAssertEqual(prepared.width, 1920); XCTAssertEqual(prepared.height, 1152)
        let output = CGImageSourceCreateWithURL(prepared.url as CFURL, nil)!
        let properties = CGImageSourceCopyPropertiesAtIndex(output, 0, nil)! as NSDictionary
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary]); XCTAssertLessThan(prepared.bytes, 3_000_000)
    }
}
