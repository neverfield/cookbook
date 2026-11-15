import assert from "node:assert/strict";
import { test } from "node:test";
import { boxes, freeShipping } from "../src/shipping.js";

test("free shipping from 50", () => {
  assert.equal(freeShipping(49), false);
  assert.equal(freeShipping(50), true);
  assert.equal(freeShipping(51), true);
});

test("six items to a box, and at least one item", () => {
  assert.equal(boxes(1), 1);
  assert.equal(boxes(6), 1);
  assert.equal(boxes(7), 2);
  assert.throws(() => boxes(0), RangeError);
  assert.throws(() => boxes(-1), RangeError);
});
