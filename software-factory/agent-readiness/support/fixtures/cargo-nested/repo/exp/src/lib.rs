/// Totals each order.
pub fn batch(orders: &[Vec<(u32, u32)>]) -> Vec<u32> {
    orders.iter().map(|o| pricing::total(o)).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn totals_each_order() {
        assert_eq!(super::batch(&[vec![(2, 3)]]), vec![6]);
    }
}
