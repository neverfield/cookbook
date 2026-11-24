import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/index.js";

test("total adds price times quantity", () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);
  assert.equal(total([]), 0);
});
