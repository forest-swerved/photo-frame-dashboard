import XCTest
@testable import FamilyFrame
@MainActor private final class FakeLocationReporter:LocationReporting {
    var tokens:[String]=[],stops:[Bool]=[],clears=0,alwaysRequests=0
    var isSharing=false
    func activate(token:String,identity:String)throws{tokens.append(token);isSharing=true}
    func bind(_ session:MobileSession?){}
    func stop(sendNow:Bool){stops.append(sendNow);isSharing=false}
    func forgetConfirmedStop(){clears += 1;isSharing=false}
    func requestAlways(){alwaysRequests += 1}
}
@MainActor final class ParentLocationTests:XCTestCase {
    private func fixture()->(ParentLocationModel,DashboardAPI,FakeLocationReporter){
        let home=Household(id:"home",title:"Synthetic family",timezone:"America/Denver")
        let session=MobileSession(authenticated:true,authType:"mobile",role:"admin",household:home,user:FamilyUser(id:"parent",name:"Dad",email:nil),personId:nil)
        let api=DashboardAPI(session:session,data:HouseholdSnapshot(household:home,role:"admin",date:"2026-10-31",people:[],chores:[]))
        let reporter=FakeLocationReporter(),model=ParentLocationModel(api:api,reporter:reporter);model.bind(session);return(model,api,reporter)
    }
    private let enabled=LocationSharingResult(sharing:ParentLocationSharing(enabled:true,version:1,label:"Dad",thisPhone:true),reportToken:String(repeating:"l",count:43))
    func testExplicitSharingUsesLimitedCredentialAndRequestsAlways() async {
        let(model,api,reporter)=fixture();api.locationChangeHandler={draft in XCTAssertTrue(draft.enabled);XCTAssertEqual(draft.expectedVersion,0);return self.enabled}
        await model.change(enabled:true,label:"Dad");XCTAssertTrue(model.sharing.enabled);XCTAssertEqual(reporter.tokens,[enabled.reportToken!]);XCTAssertEqual(reporter.alwaysRequests,1)
    }
    func testDelayedGrantCannotStartLocationAfterSignOut() async {
        let(model,api,reporter)=fixture(),result=Deferred<LocationSharingResult>();api.locationChangeHandler={_ in try await result.wait()}
        let task=Task{await model.change(enabled:true,label:"Dad")};while !result.waiting {await Task.yield()}
        model.bind(nil);result.resolve(enabled);await task.value;XCTAssertTrue(reporter.tokens.isEmpty);XCTAssertFalse(model.sharing.enabled)
    }
    func testRepeatedSharingDoesNotRotateCredentialOrEraseStationaryLocation() async {
        let(model,api,reporter)=fixture();var writes=0
        api.locationChangeHandler={_ in writes += 1;return self.enabled}
        await model.change(enabled:true,label:"Dad")
        api.locationsHandler={ParentLocationSnapshot(sharing:self.enabled.sharing)}
        await model.change(enabled:true,label:"Dad")
        XCTAssertEqual(writes,1);XCTAssertEqual(reporter.tokens.count,1);XCTAssertTrue(model.sharing.enabled)
    }
    func testMissingLocalCredentialCanRecoverAnExistingGrant() async {
        let(model,api,reporter)=fixture();var writes=0
        api.locationsHandler={ParentLocationSnapshot(sharing:self.enabled.sharing)}
        api.locationChangeHandler={_ in writes += 1;return self.enabled}
        await model.refresh();await model.change(enabled:true,label:"Dad")
        XCTAssertEqual(writes,1);XCTAssertEqual(reporter.tokens.count,1)
    }
    func testChangingMapNameStillReactivatesWithNewName() async {
        let(model,api,reporter)=fixture();var names:[String]=[]
        api.locationChangeHandler={draft in names.append(draft.label);return self.enabled}
        await model.change(enabled:true,label:"Dad")
        api.locationsHandler={ParentLocationSnapshot(sharing:self.enabled.sharing)}
        await model.change(enabled:true,label:"Forest")
        XCTAssertEqual(names,["Dad","Forest"]);XCTAssertEqual(reporter.tokens.count,2)
    }
    func testStopHaltsAcquisitionBeforeNetworkAndClearsAfterConfirmation() async {
        let(model,api,reporter)=fixture();api.locationChangeHandler={draft in XCTAssertEqual(reporter.stops,[false]);XCTAssertFalse(draft.enabled);return LocationSharingResult(sharing:.off,reportToken:nil)}
        await model.change(enabled:false,label:"Dad");XCTAssertEqual(reporter.clears,1)
    }
    func testOldReadCannotClearNewSharingCredential() async {
        let(model,api,reporter)=fixture(),result=Deferred<ParentLocationSnapshot>();api.locationsHandler={try await result.wait()}
        let read=Task{await model.refresh()};while !result.waiting{await Task.yield()}
        api.locationsHandler={ParentLocationSnapshot(sharing:.off)};api.locationChangeHandler={_ in self.enabled}
        await model.change(enabled:true,label:"Dad");result.resolve(ParentLocationSnapshot(sharing:.off));await read.value
        XCTAssertTrue(model.sharing.enabled);XCTAssertEqual(reporter.clears,0)
    }
    func testHistoryRequiresSeparateConsentAndUsesCurrentVersion() async {
        let(model,api,_)=fixture();api.locationsHandler={ParentLocationSnapshot(sharing:self.enabled.sharing)}
        var writes=0;api.historyHandler={draft in writes += 1;XCTAssertTrue(draft.enabled);XCTAssertEqual(draft.expectedVersion,1);return LocationHistoryChange(sharing:ParentLocationSharing(enabled:true,version:2,label:"Dad",thisPhone:true,historyEnabled:true))}
        await model.refresh();XCTAssertEqual(writes,0);await model.setHistory(true);XCTAssertEqual(writes,1);XCTAssertEqual(model.sharing.historyEnabled,true)
    }
    func testHistoryResponseCannotCrossSignOut() async {
        let(model,api,_)=fixture();api.locationsHandler={ParentLocationSnapshot(sharing:self.enabled.sharing)};await model.refresh()
        let result=Deferred<LocationHistoryChange>();api.historyHandler={_ in try await result.wait()}
        let task=Task{await model.setHistory(true)};while !result.waiting{await Task.yield()}
        model.bind(nil);result.resolve(LocationHistoryChange(sharing:ParentLocationSharing(enabled:true,version:2,label:"Dad",thisPhone:true,historyEnabled:true)));await task.value
        XCTAssertFalse(model.sharing.enabled);XCTAssertNil(model.sharing.historyEnabled)
    }
    func testDeletingHistoryUsesOwnAPIAndRefreshesConsent() async {
        let(model,api,_)=fixture();var deletes=0;api.historyDeleteHandler={deletes += 1};await model.deleteHistory()
        XCTAssertEqual(deletes,1);XCTAssertEqual(model.historyCount,0);XCTAssertFalse(model.sharing.historyEnabled == true)
    }
    func testBackgroundRefreshWithoutExistingGrantDoesNotEnableSharing() async {
        let reporter=ParentLocationReporter();let sent=await reporter.refreshFromPush();XCTAssertFalse(sent);XCTAssertFalse(reporter.isSharing)
    }

}
