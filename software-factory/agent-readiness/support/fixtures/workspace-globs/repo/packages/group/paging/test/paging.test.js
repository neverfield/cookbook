import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPage, hasNext, offset, pageCount } from "../src/paging.js";

test("pageCount rounds up and rejects a size of 0 or less", () => {
  assert.equal(pageCount(10, 5), 2);
  assert.equal(pageCount(11, 5), 3);
  assert.equal(pageCount(1, 5), 1);
  assert.throws(() => pageCount(10, 0), RangeError);
  assert.throws(() => pageCount(10, -1), RangeError);
  assert.equal(pageCount(10, 1), 10);
});

test("offset starts at 0 on page 1 and below", () => {
  assert.equal(offset(1, 10), 0);
  assert.equal(offset(2, 10), 10);
  assert.equal(offset(3, 10), 20);
  assert.equal(offset(0, 10), 0);
  assert.equal(offset(-1, 10), 0);
});

test("hasNext is false on the last page", () => {
  assert.equal(hasNext(1, 3), true);
  assert.equal(hasNext(2, 3), true);
  assert.equal(hasNext(3, 3), false);
  assert.equal(hasNext(4, 3), false);
});

test("clampPage stops at the last page", () => {
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(3, 3), 3);
  assert.equal(clampPage(4, 3), 3);
  assert.equal(clampPage(9, 3), 3);
});
