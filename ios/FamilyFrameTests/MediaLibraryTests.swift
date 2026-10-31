import XCTest
import UIKit
import ImageIO
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
