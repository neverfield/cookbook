import assert from "node:assert/strict";
import { test } from "node:test";
import { signer } from "./signer.js";

// The test's own signing key; tests/secrets.test.ts writes a generated one in place of the marker.
const privateKey = `__PRIVATE_KEY__`;

test("the signer takes a key", () => {
  assert.equal(typeof signer(privateKey), "function");
});
