import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { writeStamped } from "../skill/agent-readiness/scripts/lib/replay.ts";

// A planted fault and the original it is swapped back for often have the same size, and a narrowed
// test run finishes in under a second. Python trusts a .pyc whose source has the same whole-second
// modification time and size, so cleo's table.py fault kept running after the original was back and
// failed every later run, which counted unrelated faults as caught.
describe("planting a fault and putting the original back", () => {
  test("each write gets a whole-second time later than the last and than now", () => {
    const f = join(mkdtempSync(join(tmpdir(), "stamp-")), "a.py");
    writeFileSync(f, "x = 1\n");
    let last = 0;
    for (const text of ["x = 2\n", "x = 1\n", "x = 3\n", "x = 1\n"]) {
      const before = Math.floor(Date.now() / 1000);
      writeStamped(f, text);
      const t = statSync(f).mtimeMs / 1000;
      assert.equal(t, Math.floor(t), "a whole second");
      assert.ok(t > before && t > last, `${t} after ${Math.max(before, last)}`);
      last = t;
    }
  });

  test("Python runs the original again once it is back, even within the same second", () => {
    const dir = mkdtempSync(join(tmpdir(), "stamp-py-"));
    const mod = join(dir, "m.py");
    writeFileSync(mod, "VALUE = 1\n");
    const run = () => {
      const r = spawnSync("python3", ["-c", "import m; print(m.VALUE)"], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "" } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(run(), "1");
    for (let i = 0; i < 3; i++) {
      writeStamped(mod, "VALUE = 2\n");
      assert.equal(run(), "2", "the planted version runs");
      writeStamped(mod, "VALUE = 1\n");
      assert.equal(run(), "1", "the original runs again, not the cached planted version");
    }
  });
});
