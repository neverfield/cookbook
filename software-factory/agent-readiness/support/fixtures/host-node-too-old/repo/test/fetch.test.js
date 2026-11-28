import assert from "node:assert/strict";
import { test } from "node:test";
import compat from "fetch-compat";

test("the fetch helper decompresses", () => {
  assert.equal(typeof compat.decompress, "function");
});
