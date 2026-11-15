//! Order totals for the storefront, in cents.

/// The discount tier an order of `cents` reaches.
pub fn tier(cents: u64) -> u8 {
    if cents >= 10000 {
        return 2;
    }
    if cents >= 5000 {
        return 1;
    }
    0
}

/// Whether a basket ships free: at least the threshold, or a member's order.
pub fn free_shipping(cents: u64, member: bool) -> bool {
    if member {
        return true;
    }
    cents >= 7500
}

/// The order total with its tier discount, then tax for the region.
pub fn total<'a>(cents: u64, region: &'a str) -> u64 {
    let pct = match tier(cents) {
        2 => 10,
        1 => 5,
        _ => 0,
    };
    let discounted = cents - cents * pct / 100;
    discounted + tax::due(discounted, region)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_start_at_their_thresholds() {
        assert_eq!(tier(4999), 0);
        assert_eq!(tier(5000), 1);
        assert_eq!(tier(9999), 1);
        assert_eq!(tier(10000), 2);
    }

    #[test]
    fn members_always_ship_free() {
        assert!(free_shipping(100, true));
        assert!(!free_shipping(7499, false));
        assert!(free_shipping(7500, false));
    }

    #[test]
    fn totals_apply_the_discount_before_tax() {
        assert_eq!(total(10000, "OR"), 9000);
        assert_eq!(total(5000, "WA"), 5130);
        assert_eq!(total(1000, "WA"), 1080);
    }
}
