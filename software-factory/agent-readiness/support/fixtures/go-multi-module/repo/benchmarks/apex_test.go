package benchmarks

import (
	"testing"

	"example.com/ledger"
)

func BenchmarkTotal(b *testing.B) {
	for i := 0; i < b.N; i++ {
		ledger.Total([]int{2, 1}, []int{3, 1})
	}
}
