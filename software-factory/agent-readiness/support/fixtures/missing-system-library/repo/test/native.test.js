import assert from "node:assert/strict";
import { test } from "node:test";

// Loads a shared system library the code's native binding needs; the image has to provide it.
test("the native binding loads its system library", () => {
  const mod = { exports: {} };
  process.dlopen(mod, "libreadiness-fixture.so.1");
  assert.ok(mod.exports);
});
