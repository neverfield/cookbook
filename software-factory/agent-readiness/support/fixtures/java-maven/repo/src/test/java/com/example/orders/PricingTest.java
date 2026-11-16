package com.example.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PricingTest {
  @Test
  void discountTiers() {
    assertEquals(0, Pricing.discountPercent(19));
    assertEquals(5, Pricing.discountPercent(20));
    assertEquals(5, Pricing.discountPercent(99));
    assertEquals(10, Pricing.discountPercent(100));
  }

  @Test
  void shippingByWeight() {
    assertEquals(510, Pricing.shippingCents(100));
    assertEquals(1000, Pricing.shippingCents(5000));
    assertEquals(1500, Pricing.shippingCents(5001));
    assertThrows(IllegalArgumentException.class, () -> Pricing.shippingCents(0));
  }

  @Test
  void freeShippingThreshold() {
    assertFalse(Pricing.freeShipping(4999));
    assertTrue(Pricing.freeShipping(5000));
  }

  @Test
  void totals() {
    assertEquals(1500, Pricing.total(100, 10, 1));
    assertEquals(4400, Pricing.total(200, 20, 1000));
    assertEquals(9000, Pricing.total(100, 100, 9000));
  }
}
