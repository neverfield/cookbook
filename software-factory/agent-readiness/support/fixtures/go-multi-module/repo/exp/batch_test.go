package exp

import "testing"

func TestBatch(t *testing.T) {
	if got := Batch([][2][]int{{{2}, {3}}}); got[0] != 6 {
		t.Fatalf("Batch = %v", got)
	}
}
