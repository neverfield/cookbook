package com.example.orders;

/** Prices an order: a bulk discount, then shipping by weight. */
public final class Pricing {
  private Pricing() {}

  public static int discountPercent(int items) {
    if (items >= 100) {
      return 10;
    }
    if (items >= 20) {
      return 5;
    }
    return 0;
  }

  public static int shippingCents(int grams) {
    if (grams <= 0) {
      throw new IllegalArgumentException("weight must be positive");
    }
    if (grams > 5000) {
      return 1500;
    }
    return 500 + grams / 10;
  }

  public static boolean freeShipping(int totalCents) {
    if (totalCents >= 5000) {
      return true;
    }
    return false;
  }

  public static int total(int unitCents, int items, int grams) {
    int gross = unitCents * items;
    int net = gross - gross * discountPercent(items) / 100;
    return freeShipping(net) ? net : net + shippingCents(grams);
  }
}
