import assert from "node:assert/strict";
import { test } from "node:test";

// Reads the npm registry's front page, so it passes only with the network on.
test("the package registry answers", async () => {
  const res = await fetch("https://registry.npmjs.org/", { signal: AbortSignal.timeout(20_000) });
  assert.ok(res.status < 500, `registry answered ${res.status}`);
});
