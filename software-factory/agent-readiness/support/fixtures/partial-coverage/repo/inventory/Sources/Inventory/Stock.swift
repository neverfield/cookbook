public func available(onHand: Int, reserved: Int) -> Int {
    if reserved > onHand {
        return 0
    }
    return onHand - reserved
}
