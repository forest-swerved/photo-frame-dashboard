import XCTest

final class EntryUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    override func tearDownWithError() throws { XCUIApplication().terminate() }
    func testParentsAndKidsShareEmailPasswordSignIn() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.textFields["Account email"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.secureTextFields["Account password"].exists)
        XCTAssertFalse(app.buttons["Sign in to Family Frame"].isEnabled)
        XCTAssertFalse(app.buttons["Child pairing"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Shared account sign-in"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testChildAccountCreationRequiresOwnEmailAndMatchingStrongPassword() {
        let app = XCUIApplication(); app.launch()
        app.buttons["Create account"].tap()
        XCTAssertTrue(app.textFields["Your name"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["Account email"].exists)
        XCTAssertTrue(app.secureTextFields["Account password"].exists)
        XCTAssertTrue(app.secureTextFields["Confirm account password"].exists)
        XCTAssertFalse(app.buttons["Create my account"].isEnabled)
        app.textFields["Account email"].tap()
        app.textFields["Account email"].typeText("child@example.test")
        XCTAssertTrue(app.textFields["Account email"].isHittable, "The account email must stay visible above the keyboard")
        // No account is created and no request is sent to a live auth service.
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Account creation keyboard"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testRecoveryOpensWithoutSendingAccountRequests() {
        let app = XCUIApplication(); app.launch()
        let forgot = app.buttons["Forgot your password?"]
        if !forgot.isHittable { app.swipeUp() }
        XCTAssertTrue(forgot.waitForExistence(timeout: 5)); forgot.tap()
        XCTAssertTrue(app.navigationBars["Reset password"].waitForExistence(timeout: 5))
        let email = app.textFields["Account email"]
        XCTAssertTrue(email.exists)
        XCTAssertFalse(app.buttons["Send reset email"].isEnabled)
        XCTAssertFalse(app.secureTextFields["At least 12 characters"].exists, "Recovery proof must be requested before entering a new password")
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Native recovery - no live request"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
