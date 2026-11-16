import XCTest
@testable import Pantry

final class PantryListTests: XCTestCase {
    func testAddIgnoresNonPositiveCounts() {
        var list = PantryList()
        list.add("rice", count: 0)
        XCTAssertTrue(list.items.isEmpty)
    }

    func testRunningLow() {
        var list = PantryList()
        list.add("rice", count: 1)
        list.add("beans", count: 5)
        XCTAssertEqual(list.runningLow(), ["rice"])
    }
}
