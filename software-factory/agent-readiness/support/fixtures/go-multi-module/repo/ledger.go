package ledger

// Total adds price times quantity.
func Total(prices, qty []int) int {
	t := 0
	for i := range prices {
		t += prices[i] * qty[i]
	}
	return t
}
