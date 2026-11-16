import XCTest
@testable import CommerceCore

final class OrdersTests: XCTestCase {
    func testFreeShippingStartsAtFifty() {
        XCTAssertFalse(Order(total: 49).shipsFree)
        XCTAssertTrue(Order(total: 50).shipsFree)
    }
}
