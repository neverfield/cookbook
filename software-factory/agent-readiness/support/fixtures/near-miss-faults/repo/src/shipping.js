export function freeShipping(total) {
  return total >= 50;
}

export function boxes(items) {
  if (items <= 0) {
    throw new RangeError("no items");
  }
  return Math.ceil(items / 6);
}

// Shown on the packing slip; nothing checks it yet.
export function weightLabel(kg) {
  return kg > 20 ? "heavy" : "standard";
}
