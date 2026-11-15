import unittest

from pricing_engine.rules import bulk_discount, checked_quantity, is_member_price, next_tier, shipping_band


class RulesTest(unittest.TestCase):
    def test_bulk_discount_starts_at_ten(self):
        self.assertEqual(bulk_discount(9), 0)
        self.assertEqual(bulk_discount(10), 15)
        self.assertEqual(bulk_discount(11), 15)

    def test_shipping_bands(self):
        self.assertEqual(shipping_band(2), "letter")
        self.assertEqual(shipping_band(3), "parcel")
        self.assertEqual(shipping_band(20), "parcel")
        self.assertEqual(shipping_band(21), "freight")

    def test_member_codes(self):
        self.assertTrue(is_member_price("M1234"))
        self.assertFalse(is_member_price("M123"))
        self.assertFalse(is_member_price("X1234"))

    def test_next_tier(self):
        self.assertEqual(next_tier(0), 1)
        self.assertEqual(next_tier(99), 1)
        self.assertEqual(next_tier(100), 2)

    def test_checked_quantity(self):
        self.assertEqual(checked_quantity(1), 1)
        with self.assertRaises(ValueError):
            checked_quantity(0)


if __name__ == "__main__":
    unittest.main()
