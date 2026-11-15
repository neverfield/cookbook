package inventory

import "testing"

func TestAvailable(t *testing.T) {
	cases := []struct{ onHand, reserved, want int }{{10, 3, 7}, {3, 3, 0}, {2, 5, 0}}
	for _, c := range cases {
		if got := Available(c.onHand, c.reserved); got != c.want {
			t.Errorf("Available(%d, %d) = %d, want %d", c.onHand, c.reserved, got, c.want)
		}
	}
}

func TestNeedsReorder(t *testing.T) {
	cases := []struct {
		onHand, reorderAt int
		want              bool
	}{{4, 5, true}, {5, 5, true}, {6, 5, false}}
	for _, c := range cases {
		if got := NeedsReorder(c.onHand, c.reorderAt); got != c.want {
			t.Errorf("NeedsReorder(%d, %d) = %v, want %v", c.onHand, c.reorderAt, got, c.want)
		}
	}
}

func TestRestock(t *testing.T) {
	cases := []struct{ onHand, target, caseSize, want int }{{0, 12, 6, 12}, {11, 12, 6, 6}, {12, 12, 6, 0}, {20, 12, 6, 0}, {5, 12, 6, 12}}
	for _, c := range cases {
		if got := Restock(c.onHand, c.target, c.caseSize); got != c.want {
			t.Errorf("Restock(%d, %d, %d) = %d, want %d", c.onHand, c.target, c.caseSize, got, c.want)
		}
	}
}
