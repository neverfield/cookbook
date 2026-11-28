import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cases as fixtureCases } from "../support/evals/cases/fixtures.ts";
import { controlRepeats, summarize, withControls } from "../support/evals/lib/baseline.ts";
import { scriptedAudit } from "../support/evals/lib/controls.ts";
import { identities, normalize, runFingerprint } from "../support/evals/lib/fingerprint.ts";
import { gradeCase } from "../support/evals/lib/grade.ts";
import { DETERMINISTIC_REPEATS, planJobs, probeOutcome, restOf } from "../support/evals/lib/plan.ts";
import { RELEASE_POLICY, releaseVerdict } from "../support/evals/lib/release.ts";
import type { CaseRun, EvalCase } from "../support/evals/lib/types.ts";
import { prepare } from "../support/evals/lib/workspace.ts";

const driven = { id: "fixtures/a", turns: [], tags: [] } as unknown as EvalCase;
const negative = { id: "negative/b", turns: [], tags: [], attack: () => ({}) } as unknown as EvalCase;

function run(id: string, repeat: number, pass: boolean, extra: Partial<CaseRun> = {}): CaseRun {
  return { id, repeat, model: "claude-opus-5-5", driver: "sdk", arm: "agent", judgeModel: "gemini-4-argon,gpt-5.6-sol", rubric: "2026-12-beta", workspace: "", error: null, grade: { gates: [{ name: "sealed", pass: true, detail: "" }, { name: "levels", pass, detail: "" }], soft: { judge: 0.85, judgeReasons: [], page: 0.7, pageReasons: [], wallMs: 1, toolCalls: 1, tokens: null } }, ...extra };
}

describe("the scripted arm and the negative cases stop at two runs that match", () => {
  test("the plan probes deterministic jobs at 2 repeats and keeps the agent arm at 5; without a probe nothing changes", () => {
    const count = (jobs: ReturnType<typeof planJobs>, pick: (j: (typeof jobs)[number]) => boolean) => jobs.filter(pick).length;
    const probed = planJobs([driven, negative], ["agent", "scripted"], ["m"], 5, DETERMINISTIC_REPEATS);
    assert.equal(count(probed, (j) => j.arm === "agent" && !j.c.attack), 5);
    assert.equal(count(probed, (j) => j.arm === "scripted"), 2);
    assert.equal(count(probed, (j) => Boolean(j.c.attack)), 2);
    const full = planJobs([driven, negative], ["agent", "scripted"], ["m"], 5);
    assert.equal(full.length, 15);
    assert.equal(planJobs([driven, negative], ["agent", "scripted"], ["m"], 1, DETERMINISTIC_REPEATS).length, 3, "a 1-repeat run is unchanged");
    assert.deepEqual(restOf(probed.find((j) => j.arm === "scripted")!, 2, 5).map((j) => j.r), [3, 4, 5]);
  });

  test("a probe stands for every repeat only when every run finished, none was lost, and the fingerprints are equal", () => {
    const ok = { fingerprint: "x", error: null };
    assert.deepEqual(probeOutcome([ok, ok], 2), { matched: true });
    assert.equal(probeOutcome([ok], 2).matched, false);
    assert.equal(probeOutcome([ok, { ...ok, fingerprint: "y" }], 2).matched, false);
    assert.equal(probeOutcome([ok, { ...ok, fingerprint: null }], 2).matched, false);
    assert.equal(probeOutcome([ok, { ...ok, infra: { lost: true } }], 2).matched, false);
  });

  test("two scripted audits of one fixture match once their own ids, commits and paths are replaced; one changed byte doesn't", () => {
    const base = fixtureCases.find((c) => c.id === "hidden-service")!;
    const c: EvalCase = { ...base, id: "fixtures/hidden-service", env: { ...base.env, SA_READINESS_RUNTIME: "none", SA_READINESS_ALLOW_HOST: "1" } };
    const [a, b] = [prepare(c), prepare(c)];
    const prints = [a, b].map((ws) => {
      const t = scriptedAudit(ws, c);
      return { ws, t, gates: gradeCase(ws, t, c) };
    });
    const [pa, pb] = prints.map((p) => runFingerprint(p.ws, p.gates, p.t.error));
    const report = (ws: typeof a) => readFileSync(join(ws.dir, ".agent-readiness/latest/report.json"), "utf8");
    assert.notEqual(report(a), report(b), "raw reports carry each run's own audit id");
    assert.equal(pa, pb);
    assert.notEqual(runFingerprint(a, prints[0].gates, "readiness audit exited 1"), pa, "an error is part of the fingerprint");
    assert.notEqual(runFingerprint(a, prints[0].gates.map((g, i) => (i ? g : { ...g, pass: !g.pass })), null), pa, "a gate result is part of it");
    appendFileSync(join(b.dir, ".agent-readiness/latest/report.md"), " ");
    assert.notEqual(runFingerprint(b, prints[1].gates, prints[1].t.error), pa, "one byte of a report changes it");
  });

  test("normalizing replaces only a run's own identity", () => {
    const ids: [string, string][] = [["aud-2026-11-28-203f270-ec95", "<record-1>"], ["ec95", "<record-1-suffix>"], ["203f270", "<commit-1>"]];
    assert.equal(normalize("aud-2026-11-28-203f270-ec95 at 203f270, ec95; level 2 of 3 at 1234567", ids), "<record-1> at <commit-1>, <record-1-suffix>; level 2 of 3 at 1234567");
    assert.equal(normalize('"durationMs": 87, "exitCode": 1; npm test in api, 12 s; timeout 30 s', []), '"durationMs": <ms>, "exitCode": 1; npm test in api, <duration>; timeout 30 s', "only command timings are masked");
    assert.equal(identities({ dir: "/nonexistent/x", fixture: "", now: "", skillDigestBefore: "", headBefore: "" }).at(-1)![1], "<workspace-root>");
  });
});

describe("the release check and a scripted arm that stopped early", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const PANEL = "gemini-4-argon,gpt-5.6-sol";
  const R5 = { model: "claude-opus-5-5", driver: "sdk", repeats: 5, judgePrompt: "abc", judgeSamples: 3, binding: { commit: "f".repeat(40), dirty: false, scripts: "s1", rubric: "r1", evals: "e1" } };
  const CTX = { binding: R5.binding, calibration: { ranAt: "2026-11-15T00:00:00Z", judgePrompt: "abc", models: PANEL.split(","), samples: 3, agree: 28, total: 30, auc: 1 } };
  const agent = ids.flatMap((id) => Array.from({ length: 5 }, (_, i) => run(id, i + 1, true)));
  const scriptedRuns = (n: (id: string) => number, print: (id: string, rep: number) => Partial<CaseRun>) =>
    ids.flatMap((id) => Array.from({ length: n(id) }, (_, i) => run(id, i + 1, false, { arm: "scripted", model: "scripted", driver: "scripted", ...print(id, i + 1) })));
  const verdict = (scripted: CaseRun[]) => releaseVerdict(withControls(summarize(agent, R5), agent, { scripted }), CTX);

  test("two matching runs per case pass, and the check says how many cases stopped early", () => {
    const v = verdict(scriptedRuns(() => 2, () => ({ fingerprint: "same" })));
    assert.equal(v.pass, true, v.lines.join("\n"));
    assert.ok(v.lines.includes(`OK scripted arm repeats: 12 of 12 cases matched byte for byte in ${RELEASE_POLICY.deterministicRepeats} runs, 0 ran 5 or more`), v.lines.join("\n"));
  });

  test("two runs that differ, a lost run, a missing fingerprint or a single run fail; a case that fell back to 5 passes", () => {
    const differ = verdict(scriptedRuns(() => 2, (id, rep) => ({ fingerprint: id === "c3" ? `p${rep}` : "same" })));
    assert.equal(differ.pass, false);
    assert.ok(differ.lines.includes("FAIL scripted arm, c3: 2 runs that don't match; the policy needs 5, or 2 that match byte for byte"), differ.lines.join("\n"));
    const lost = verdict(scriptedRuns(() => 2, (id, rep) => ({ fingerprint: "same", ...(id === "c4" && rep === 2 ? { infra: { attempts: 3, errors: ["ECONNRESET"], lost: true } } : {}) })));
    assert.equal(lost.pass, false);
    assert.equal(verdict(scriptedRuns(() => 2, () => ({}))).pass, false, "runs recorded with no fingerprint can't stop at 2");
    assert.equal(verdict(scriptedRuns((id) => (id === "c1" ? 1 : 2), () => ({ fingerprint: "same" }))).pass, false);
    const fellBack = verdict(scriptedRuns((id) => (id === "c3" ? 5 : 2), (id, rep) => ({ fingerprint: id === "c3" ? `p${rep}` : "same" })));
    assert.equal(fellBack.pass, true, fellBack.lines.join("\n"));
    assert.ok(fellBack.lines.includes("OK scripted arm repeats: 11 of 12 cases matched byte for byte in 2 runs, 1 ran 5 or more"));
  });

  test("a summary recorded before this change, with no per-case repeats, is checked as before", () => {
    const s = withControls(summarize(agent, R5), agent, { scripted: scriptedRuns(() => 5, () => ({})) });
    delete s.controls!.scripted!.repeats;
    assert.equal(releaseVerdict(s, CTX).pass, true);
    assert.deepEqual(controlRepeats(scriptedRuns(() => 5, () => ({}))).c0, { runs: 5, matched: false });
  });
});
