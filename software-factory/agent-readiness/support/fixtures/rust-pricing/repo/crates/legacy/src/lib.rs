//! The old price list, kept out of the workspace. Its tests never run with the workspace's.

pub fn old_tier(cents: u64) -> u8 {
    if cents >= 20000 {
        return 3;
    }
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn old_tier() {
        assert_eq!(super::old_tier(20000), 3);
    }
}
