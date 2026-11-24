package exp

import "example.com/ledger"

// Batch totals each order.
func Batch(orders [][2][]int) []int {
	out := make([]int, len(orders))
	for i, o := range orders {
		out[i] = ledger.Total(o[0], o[1])
	}
	return out
}
