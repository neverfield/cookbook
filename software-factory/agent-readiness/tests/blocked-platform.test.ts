import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { notSupportedReason } from "../skill/agent-readiness/scripts/lib/support.ts";
import { defectClaim } from "../support/evals/lib/platforms.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// Every component skipped, each in the given stack: the headline the report would carry.
function headline(parts: [id: string, share: number, stack: string][]): string {
  const audit = makeAudit({ components: parts.map(([id, share]) => ({ id, share, assessed: false })) });
  for (const c of audit.profile!.components) {
    c.stack = parts.find(([id]) => id === c.id)![2];
    c.notAssessedReason = notSupportedReason(c.stack);
  }
  return reportFor(audit).executive.headline;
}

const PREFIX = "No component could be assessed, so this audit can't give a level yet: ";

describe("the headline when every component is blocked by the platform it builds on", () => {
  test("names the need, and says blocked on this machine, not broken", () => {
    assert.equal(headline([["Ledger", 1, "dotnet-windows"]]), `${PREFIX}Ledger needs Windows to build; it's blocked on this machine, not broken.`);
    assert.equal(headline([["Pantry", 1, "xcode"]]), `${PREFIX}Pantry needs macOS with Xcode to build; it's blocked on this machine, not broken.`);
    assert.equal(
      headline([["Ledger", 0.6, "dotnet-windows"], ["Pantry", 0.3, "xcode"], ["Admin", 0.1, "dotnet-windows"]]),
      `${PREFIX}Ledger and Admin need Windows and Pantry needs macOS with Xcode to build; they're blocked on this machine, not broken.`,
    );
  });

  test("past the word limit, it names the needs without the components", () => {
    const many = Array.from({ length: 12 }, (_, i) => [`windows-project-${i + 1}`, 1 / 12, i % 2 ? "xcode" : "dotnet-windows"] as [string, number, string]);
    assert.equal(headline(many), `${PREFIX}all 12 components need Windows or macOS with Xcode to build; they're blocked on this machine, not broken.`);
  });

  test("a toolchain the audit doesn't support yet keeps its wording, alone or next to a blocked part", () => {
    for (const parts of [[["infra", 1, "terraform"]], [["Ledger", 0.5, "dotnet-windows"], ["infra", 0.5, "terraform"]]] as [string, number, string][][]) {
      const h = headline(parts);
      assert.ok(h.startsWith(`${PREFIX}it skipped `), h);
      assert.doesNotMatch(h, /blocked on this machine, not broken/);
    }
  });
});

describe("the eval gate on platform-blocked parts reads who can't build", () => {
  test("the machine or its containers as the subject is the limit; the component as the subject is a defect", () => {
    for (const ok of [
      "Decide whether to run Ledger's checks on a Windows machine, since the audit's Linux containers can't build or test a Windows desktop app.",
      "Ledger needs Windows to build; it's blocked on this machine, not broken.",
      "This machine can't build Ledger, which needs Windows.",
    ])
      assert.equal(defectClaim(ok), null, ok);
    assert.equal(defectClaim("Ledger can't build in a clean checkout."), "can't build");
    assert.equal(defectClaim("Ledger is broken and its containers can't build it."), "broken");
    assert.equal(defectClaim("Ledger has no tests."), "has no tests");
  });
});
