import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CI_CONCLUSIONS, CLASSES, CLEAN_PASSES, ECOSYSTEMS, HOLDOUT, NEXT_ACTIONS, PLACEMENTS, PROTOCOL_FILES, TESTS_NEED, commandSignature, fileDigest, loadThresholds, protocolDigest, recordProblems, scoreRepo, totals, truthProblems, verdict, wilson } from "../support/holdout/score.ts";
import type { HoldoutRecord, Observation, ObservedComponent, Truth, TruthComponent } from "../support/holdout/score.ts";
import { FIXTURES, SUPPORT, truthFixtureNames } from "../support/tools/fixture.ts";
import { guards } from "../support/tools/known-failures.ts";

const guard = guards(import.meta.url);

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

interface Frozen {
  frozenAt: string;
  files: Record<string, string>;
  protocol: string;
  amendments: { date: string; file: string; from: string; to: string; reason: string }[];
}

describe("the holdout protocol is frozen", () => {
  const frozen = json(join(HOLDOUT, "frozen.json")) as Frozen;

  test("every protocol file matches its frozen digest, except through the one thresholds amendment", () => {
    const th = loadThresholds();
    assert.ok(frozen.amendments.length <= th.looks.amendments, `${frozen.amendments.length} amendments; the protocol allows ${th.looks.amendments}`);
    for (const a of frozen.amendments) {
      assert.equal(a.file, "thresholds.json", "only the thresholds may be amended");
      assert.ok(a.reason.trim().length > 20 && /^\d{4}-\d{2}-\d{2}$/.test(a.date), "an amendment gives its date and a written reason");
      assert.equal(a.from, frozen.files["thresholds.json"]);
    }
    for (const f of PROTOCOL_FILES) {
      const want = f === "thresholds.json" && frozen.amendments.length ? frozen.amendments.at(-1)!.to : frozen.files[f];
      assert.equal(fileDigest(join(HOLDOUT, f)), want, `support/holdout/${f} changed after it was frozen; PROTOCOL.md section 7 allows one amendment to thresholds.json only`);
    }
    if (!frozen.amendments.length) assert.equal(protocolDigest(), frozen.protocol);
  });

  test("the schemas' enumerations are the scorer's", () => {
    const truth = json(join(HOLDOUT, "truth.schema.json"));
    const comp = truth.properties.components.items.properties;
    assert.deepEqual(truth.properties.ci.properties.conclusion.enum, [...CI_CONCLUSIONS]);
    assert.deepEqual(comp.ecosystem.enum, [...ECOSYSTEMS]);
    assert.deepEqual(comp.placement.enum, [...PLACEMENTS]);
    assert.deepEqual(comp.testsNeed.enum, [...TESTS_NEED]);
    assert.deepEqual(comp.cleanPasses.enum, [...CLEAN_PASSES]);
    assert.deepEqual(truth.properties.nextAction.properties.kind.enum, [...NEXT_ACTIONS]);
    const record = json(join(HOLDOUT, "record.schema.json"));
    const pattern = Object.keys(record.properties.runs.items.properties.classes.patternProperties)[0];
    for (const c of CLASSES) assert.match(c, new RegExp(pattern), `record.schema.json allows class ${c}`);
    assert.equal(CLASSES.filter((c) => !/^K\d$/.test(c)).length + 1, pattern.slice(2, -2).split("|").length, "and no other class");
  });

  test("no file in support/holdout names a repository, except the collision log", () => {
    const named = /github\.com\/[\w.-]+\/[\w.-]+|\b[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}\b/;
    for (const f of readdirSync(HOLDOUT).filter((n) => n !== "collision-log.json" && !n.startsWith("."))) {
      const p = join(HOLDOUT, f);
      if (!existsSync(p) || f === "records") continue;
      assert.doesNotMatch(readFileSync(p, "utf8"), named, `support/holdout/${f} names a repository`);
    }
  });

  guard("the steward's commitment to the holdout manifest is committed", () => {
    const dir = join(HOLDOUT, "records");
    const records = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => json(join(dir, n)) as HoldoutRecord) : [];
    assert.ok(records.some((r) => r.kind === "commitment" && recordProblems(r).length === 0), "no commitment record under support/holdout/records/; PROTOCOL.md section 4 needs one before PR B merges");
  });

  test("every record the steward commits has only enumerations, counts, hashes, commit ids and dates", () => {
    const dir = join(HOLDOUT, "records");
    for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []) assert.deepEqual(recordProblems(json(join(dir, f))), [], f);
  });
});

describe("development-set truth", () => {
  const trials = json(join(SUPPORT, "trials", "trials.json")).trials as { id: string; repo: string; commit: string }[];

  test("every trial has truth in the holdout's schema, for its own repo and commit", () => {
    for (const t of trials) {
      const p = join(SUPPORT, "trials", "truth", `${t.id}.json`);
      assert.ok(existsSync(p), `trials/truth/${t.id}.json`);
      const truth = json(p) as Truth;
      assert.deepEqual(truthProblems(truth), [], t.id);
      assert.equal(truth.repo, t.repo);
      assert.equal(truth.commit, t.commit);
    }
    assert.deepEqual(readdirSync(join(SUPPORT, "trials", "truth")).sort(), trials.map((t) => `${t.id}.json`).sort(), "one truth file per trial");
  });

  test("umami, zap and Flexget are trials", () => {
    assert.deepEqual(["umami-software/umami", "uber-go/zap", "Flexget/Flexget"].filter((r) => !trials.some((t) => t.repo === r)), []);
  });

  test("every truth fixture's truth is in the schema", () => {
    assert.ok(truthFixtureNames().length >= 10);
    for (const name of truthFixtureNames()) assert.deepEqual(truthProblems(json(join(FIXTURES, name, "truth.json"))), [], name);
  });

  test("the collision log lists every trial and golden repo", () => {
    const log = json(join(HOLDOUT, "collision-log.json")) as { entries: { repo: string; commit: string | null; date: string; by: string; why: string }[] };
    for (const e of log.entries) assert.ok(/^[\w.-]+\/[\w.-]+$/.test(e.repo) && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.by && e.why, JSON.stringify(e));
    const logged = (repo: string, commit: string) => log.entries.some((e) => e.repo === repo && (e.commit === null || commit.startsWith(e.commit) || e.commit.startsWith(commit)));
    for (const t of trials) assert.ok(logged(t.repo, t.commit), `${t.repo}@${t.commit.slice(0, 7)} isn't in the collision log`);
    const goldens = json(join(SUPPORT, "evals", "goldens", "goldens.json")).goldens as { repo: string; sha: string }[];
    for (const g of goldens) assert.ok(logged(g.repo, g.sha), `${g.repo}@${g.sha.slice(0, 7)} isn't in the collision log`);
  });
});

function truthOf(components: Partial<TruthComponent>[], over: Partial<Truth> = {}): Truth {
  return {
    schema: "agent-readiness/holdout-truth@1",
    repo: "example/one",
    commit: "a".repeat(40),
    ci: { conclusion: "success" },
    components: components.map((c) => ({ path: ".", ecosystem: "node", placement: "component", changeShare: 1, hasTests: true, install: ["npm ci"], test: ["npm test"], testsNeed: "nothing", cleanPasses: "yes", ...c })),
    unownedShare: 0,
    secrets: [],
    nextAction: { kind: "none" },
    dropped: 0,
    ...over,
  };
}

function obsOf(components: Partial<ObservedComponent>[], over: Partial<Observation> = {}): Observation {
  return {
    schema: "agent-readiness/holdout-observation@1",
    arm: "scripted",
    environment: "container",
    sealed: true,
    crashed: false,
    overBudget: false,
    components: components.map((c) => ({ path: ".", placement: "component", level: 1, status: "proven", noTests: false, testCommand: "npm run test", ...c })),
    unownedShare: 0,
    blocking: [],
    harmfulAdvice: 0,
    after: { testCommandRefused: false, treeChanged: false, leftovers: false },
    factConflicts: 0,
    agent: null,
    statesDifference: false,
    ...over,
  };
}

describe("the holdout scorer", () => {
  test("a right answer has no critical event and meets every rate it measures", () => {
    const s = scoreRepo(truthOf([{}]), obsOf([{}]), { vm: obsOf([{}], { environment: "disposable_vm" }), judged: [true, true] });
    assert.deepEqual(s.classes, {});
    for (const r of ["R1", "R2", "R3", "R4", "R5", "R6"] as const) assert.deepEqual(s.rates[r], { hit: 1, of: 1 }, r);
  });

  test("each critical event", () => {
    const k = (truth: Truth, obs: Observation) => Object.entries(scoreRepo(truth, obs).critical).filter(([, n]) => n > 0).map(([id]) => id);
    assert.deepEqual(k(truthOf([{}]), obsOf([{ level: 0 }])), ["K1"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{ noTests: true, level: null, status: "undetermined" }])), ["K1"]);
    assert.deepEqual(k(truthOf([{ testsNeed: "service" }]), obsOf([{ level: 0 }])), [], "Level 0 can be right when the tests need a service");
    assert.deepEqual(k(truthOf([{}], { ci: { conclusion: "failure" } }), obsOf([{ level: 0 }])), []);
    assert.deepEqual(k(truthOf([{ cleanPasses: "no" }]), obsOf([{ level: 1 }])), ["K2"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { blocking: [{ file: "a.py", line: 3 }] })), ["K3"]);
    assert.deepEqual(k(truthOf([{}], { secrets: [{ file: "a.py", line: 3, real: true }] }), obsOf([{}], { blocking: [{ file: "a.py", line: 3 }] })), []);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { harmfulAdvice: 1 })), ["K3"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { sealed: false })), ["K4"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { after: { testCommandRefused: true, treeChanged: false, leftovers: false } })), ["K5"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { factConflicts: 2 })), ["K6"]);
    assert.deepEqual(k(truthOf([{}]), obsOf([{}], { arm: "agent", agent: { undefinedCommands: 1, repoCodeOutsideScripts: 0 } })), ["K7"]);
  });

  test("placement: a weighty component must be present and placed; a member is covered by its component", () => {
    const truth = truthOf([{ path: ".", changeShare: 0.6 }, { path: "plugins/a", changeShare: 0.3 }, { path: "docs", placement: "satellite", of: ".", changeShare: 0.05, hasTests: false, test: [] }, { path: "packages/m", placement: "member", of: ".", changeShare: 0.05 }]);
    assert.deepEqual(scoreRepo(truth, obsOf([{}, { path: "plugins/a" }])).rates.R1, { hit: 1, of: 1 }, "the satellite and member are under the share floor");
    assert.equal(scoreRepo(truth, obsOf([{}])).classes.R1_missing, 1);
    assert.equal(scoreRepo(truth, obsOf([{}, { path: "plugins/a", placement: "satellite", level: null, status: "not_assessed" }])).classes.R1_misplaced, 1);
    const member = truthOf([{ path: ".", changeShare: 0.5 }, { path: "packages/m", placement: "member", of: ".", changeShare: 0.5 }]);
    assert.deepEqual(scoreRepo(member, obsOf([{}])).rates.R1, { hit: 1, of: 1 });
    const unsupported = truthOf([{ path: "infra", ecosystem: "terraform", changeShare: 1 }]);
    assert.deepEqual(scoreRepo(unsupported, obsOf([{ path: "infra", placement: "excluded", level: null, status: "not_assessed" }])).rates.R1, { hit: 1, of: 1 }, "an unsupported stack may be listed as not assessed");
  });

  test("test commands match on what they run, not on flags or wrappers", () => {
    const same = [
      ["npm test", "npm run test"],
      ["corepack pnpm run test", "pnpm test"],
      [".readiness-venv/bin/python -m pytest -q", "uv run --group test pytest -n logical"],
      ["go test -count=1 -v ./...", "go test -race ./..."],
      ["cargo test --locked --offline -q", "cd exp && cargo test"],
      ["tox -e py312", "python -m tox"],
    ];
    for (const [a, b] of same) assert.equal(commandSignature(a), commandSignature(b), `${a} vs ${b}`);
    const different = [
      ["npm run test:unit", "npm test"],
      ["make test", "make cover"],
      ["npm test", "pnpm test"],
      ["node --test", "node index.js"],
    ];
    for (const [a, b] of different) assert.notEqual(commandSignature(a), commandSignature(b), `${a} vs ${b}`);
    assert.equal(scoreRepo(truthOf([{ test: ["make test"] }]), obsOf([{ testCommand: "npm run test" }])).classes.R2_other_command, 1);
    assert.equal(scoreRepo(truthOf([{ test: ["make test"] }]), obsOf([{ testCommand: null }])).classes.R2_no_command, 1);
  });

  test("a proven level counts only in the container run, and abstaining never meets it", () => {
    assert.equal(scoreRepo(truthOf([{}]), obsOf([{ level: null, status: "undetermined" }])).classes.R3_undetermined, 1);
    assert.equal(scoreRepo(truthOf([{}]), obsOf([{ level: null, status: "unproven" }])).classes.R3_unproven, 1);
    assert.deepEqual(scoreRepo(truthOf([{}]), obsOf([{}], { environment: "disposable_vm" })).rates.R3, { hit: 0, of: 0 });
  });

  test("environments must agree or the report must say what differed", () => {
    const vm = obsOf([{ level: null, status: "unproven" }], { environment: "disposable_vm" });
    assert.equal(scoreRepo(truthOf([{}]), obsOf([{}]), { vm }).classes.R5_disagree, 1);
    assert.deepEqual(scoreRepo(truthOf([{}]), obsOf([{}]), { vm: { ...vm, statesDifference: true } }).rates.R5, { hit: 1, of: 1 });
  });

  test("the unowned share must be reported and within tolerance", () => {
    assert.equal(scoreRepo(truthOf([{}], { unownedShare: 0.3 }), obsOf([{}], { unownedShare: 0.2 })).classes.R6_off, 1);
    assert.deepEqual(scoreRepo(truthOf([{}], { unownedShare: 0.3 }), obsOf([{}], { unownedShare: 0.26 })).rates.R6, { hit: 1, of: 1 });
    assert.equal(scoreRepo(truthOf([{}], { unownedShare: 0.3 }), obsOf([{}], { unownedShare: null })).classes.R6_not_reported, 1);
  });

  test("a test attempt fails on any critical event, on a rate below its bar, and on a rate with nothing to count", () => {
    const good = Array.from({ length: 24 }, () => scoreRepo(truthOf([{}]), obsOf([{}]), { vm: obsOf([{}], { environment: "disposable_vm" }), judged: [true, true] }));
    assert.deepEqual(verdict([totals(good, "container", "scripted")]), { pass: true, failed: [] });
    const oneK = [...good.slice(1), scoreRepo(truthOf([{}]), obsOf([{ level: 0 }]), { vm: obsOf([{}], { environment: "disposable_vm" }), judged: [true, true] })];
    assert.deepEqual(verdict([totals(oneK, "container", "scripted")]).failed, ["K1"]);
    const unjudged = Array.from({ length: 24 }, () => scoreRepo(truthOf([{}]), obsOf([{}]), { vm: obsOf([{}], { environment: "disposable_vm" }) }));
    assert.deepEqual(verdict([totals(unjudged, "container", "scripted")]).failed, ["R4"]);
    const agentK = totals([scoreRepo(truthOf([{}]), obsOf([{}], { arm: "agent", agent: { undefinedCommands: 0, repoCodeOutsideScripts: 1 } }))], "container", "agent");
    assert.deepEqual(verdict([totals(good, "container", "scripted"), agentK]).failed, ["K7"]);
  });

  test("intervals are Wilson's, and 0 of 24 bounds the rate near 12% one-sided", () => {
    assert.deepEqual(wilson(0, 24), { low: 0, high: 0.138 });
    assert.deepEqual(wilson(0, 24, 0.9), { low: 0, high: 0.101 });
    assert.equal(wilson(0, 0), null);
  });

  test("a record holds no free text, and the scorer's command line writes one that names no repo", () => {
    const commitment: HoldoutRecord = { schema: "agent-readiness/holdout-record@1", kind: "commitment", date: "2026-11-25", commitment: "c".repeat(64) };
    assert.deepEqual(recordProblems(commitment), []);
    assert.deepEqual(recordProblems({ ...commitment, note: "repo example/one failed" } as HoldoutRecord), ["note isn't allowed"]);
    const dir = mkdtempSync(join(tmpdir(), "holdout-cli-"));
    mkdirSync(join(dir, "truth"));
    mkdirSync(join(dir, "obs"));
    writeFileSync(join(dir, "truth", "k1.json"), JSON.stringify(truthOf([{}], { repo: "example/secret-name" })));
    writeFileSync(join(dir, "obs", "k1.container.scripted.json"), JSON.stringify(obsOf([{}])));
    writeFileSync(join(dir, "obs", "k1.disposable_vm.scripted.json"), JSON.stringify(obsOf([{}], { environment: "disposable_vm" })));
    const out = join(dir, "record.json");
    execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(HOLDOUT, "score.ts"), "--truth", join(dir, "truth"), "--observations", join(dir, "obs"), "--set", "validation", "--attempt", "1", "--commitment", "c".repeat(64), "--tool-commit", "d".repeat(40), "--scripts", "e".repeat(16), "--rubric", "f".repeat(16), "--protocol", protocolDigest(), "--out", out]);
    const record = readFileSync(out, "utf8");
    assert.deepEqual(recordProblems(JSON.parse(record)), []);
    assert.doesNotMatch(record, /secret-name|example\//);
    assert.equal(JSON.parse(record).verdict, null, "a validation look has no verdict");
  });
});
