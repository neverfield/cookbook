public struct Order {
    public let total: Int

    public init(total: Int) {
        self.total = total
    }

    public var shipsFree: Bool {
        total >= 50
    }
}
