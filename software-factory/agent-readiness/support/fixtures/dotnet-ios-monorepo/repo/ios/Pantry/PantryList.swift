import Foundation

/// The items in a pantry and which ones are running low.
struct PantryList {
    var items: [String: Int] = [:]

    mutating func add(_ name: String, count: Int) {
        if count <= 0 {
            return
        }
        items[name, default: 0] += count
    }

    func runningLow(threshold: Int = 2) -> [String] {
        return items.filter { $0.value < threshold }.map { $0.key }.sorted()
    }
}
