from pricing import total


def test_total_adds_price_times_quantity():
    assert total([(2, 3), (1, 1)]) == 7
    assert total([]) == 0
