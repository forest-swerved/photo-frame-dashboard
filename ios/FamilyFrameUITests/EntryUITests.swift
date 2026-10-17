import XCTest

final class EntryUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    override func tearDownWithError() throws { XCUIApplication().terminate() }
    func testParentEntryShowsNativeAccessibleFields() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.textFields["Parent email"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.secureTextFields["Parent password"].exists)
        XCTAssertFalse(app.buttons["Sign in"].isEnabled)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Parent sign-in"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testChildPairingUsesCodeAndDoesNotRequireParentCredentials() {
        let app = XCUIApplication(); app.launch()
        app.buttons["Child pairing"].tap()
        let field = app.textFields["Six-digit child pairing code"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields["Parent password"].exists)
        XCTAssertFalse(app.buttons["Pair my device"].isEnabled)
        field.tap(); field.typeText("123456")
        XCTAssertTrue(app.buttons["Pair my device"].isEnabled)
        XCTAssertTrue(field.isHittable, "The focused code field must stay visible above the keyboard")
        // This synthetic code is never submitted to the live API.
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Child pairing keyboard"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
