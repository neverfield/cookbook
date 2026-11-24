/// Total adds price times quantity.
pub fn total(items: &[(u32, u32)]) -> u32 {
    items.iter().map(|(p, q)| p * q).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_price_times_quantity() {
        assert_eq!(total(&[(2, 3), (1, 1)]), 7);
    }
}
