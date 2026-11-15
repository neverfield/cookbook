//! Sales tax by region, in cents, rounded down.

/// The rate for a region, in tenths of a percent.
pub fn rate(region: &str) -> u64 {
    match region {
        "OR" => 0,
        "WA" => 80,
        _ => 60,
    }
}

/// The tax due on `cents` in `region`.
pub fn due(cents: u64, region: &str) -> u64 {
    let r = rate(region);
    if r == 0 {
        return 0;
    }
    cents * r / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_by_region() {
        assert_eq!(rate("OR"), 0);
        assert_eq!(rate("WA"), 80);
        assert_eq!(rate("ID"), 60);
    }

    #[test]
    fn tax_due_rounds_down() {
        assert_eq!(due(1000, "WA"), 80);
        assert_eq!(due(999, "WA"), 79);
        assert_eq!(due(1000, "OR"), 0);
        assert_eq!(due(1000, "ID"), 60);
    }
}
