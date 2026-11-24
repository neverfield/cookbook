package ledger

import "testing"

func TestTotal(t *testing.T) {
	if got := Total([]int{2, 1}, []int{3, 1}); got != 7 {
		t.Fatalf("Total = %d, want 7", got)
	}
}
