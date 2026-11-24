import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe } from "node:test";
import { afterAudit, auditFiles, factConflicts, observe } from "../support/holdout/observe.ts";
import { CRITICAL, scoreRepo } from "../support/holdout/score.ts";
import type { Observation, RepoScore, Truth } from "../support/holdout/score.ts";
import { guards } from "../support/tools/known-failures.ts";
import { FIXTURES, materialize, readiness, truthFixtureNames } from "../support/tools/fixture.ts";

// Every fixture with a truth.json is audited as on a machine with no container runtime and scored
// against its truth by the holdout's scorer. One guard per critical event and per rate this run can
// measure: R3 needs a container, R4 the steward's judges and R5 a second environment.
const guard = guards(import.meta.url);
const RATES = ["R1", "R2", "R6"] as const;
const NOW = "2026-11-24T12:00:00Z";

interface Run {
  truth: Truth;
  obs: Observation;
  score: RepoScore;
  repo: string;
  out: string;
}

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.(csproj|fsproj|vbproj|sln|slnx)|composer\.json|Gemfile|Package\.swift|pubspec\.yaml|mix\.exs)$/;

function audited(name: string): Run {
  const truth = JSON.parse(readFileSync(join(FIXTURES, name, "truth.json"), "utf8")) as Truth;
  const repo = materialize(name, { now: NOW });
  const tmp = mkdtempSync(join(tmpdir(), "dev-truth-tmp-"));
  const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"], { SA_READINESS_EVAL_SEED: "fixture-seed", SA_READINESS_NOW: NOW, TMPDIR: tmp });
  const obs = observe(repo, { exit: r.code, after: afterAudit(repo, { tmp }) });
  return { truth, obs, score: scoreRepo(truth, obs), repo, out: r.out };
}

const shown = (run: Run) => `observed: ${JSON.stringify({ sealed: run.obs.sealed, components: run.obs.components, unownedShare: run.obs.unownedShare, blocking: run.obs.blocking, harmfulAdvice: run.obs.harmfulAdvice, factConflicts: run.obs.factConflicts, after: run.obs.after })}`;

for (const name of truthFixtureNames()) {
  describe(`${name} against its truth`, () => {
    let run: Run;
    before(() => {
      run = audited(name);
    });
    for (const k of CRITICAL.filter((c) => c !== "K7")) {
      guard(`${name} truth ${k}`, () => {
        const extra = k === "K6" ? `; conflicts: ${JSON.stringify(factConflicts(auditFiles(run.repo)))}` : k === "K4" ? `; output ends: ${run.out.slice(-800)}` : "";
        assert.equal(run.score.critical[k], 0, `${k}: ${run.score.critical[k]} event(s). ${shown(run)}${extra}`);
      });
    }
    for (const r of RATES) {
      guard(`${name} truth ${r}`, () => {
        const t = run.score.rates[r];
        assert.equal(t.hit, t.of, `${r}: ${t.hit} of ${t.of}; classes ${JSON.stringify(run.score.classes)}. ${shown(run)}`);
      });
    }
    if (name === "go-multi-module") {
      guard(`${name}: every unit's manifest is a manifest file`, () => {
        const f = auditFiles(run.repo);
        const units = [...(f.report?.components.included ?? []), ...(f.report?.components.excluded ?? [])] as { path: string; manifest: string | null }[];
        const wrong = units.filter((u) => u.manifest !== null && !MANIFEST.test(u.manifest)).map((u) => `${u.path}: ${u.manifest}`);
        assert.deepEqual(wrong, []);
      });
    }
    if (name === "pnpm-root-app") {
      guard(`${name}: workspace members report the root lockfile`, () => {
        const f = auditFiles(run.repo);
        const members = (f.report?.components.included ?? []).filter((c: { path: string }) => c.path.startsWith("packages/")) as { path: string; lockfile: string | null }[];
        assert.ok(members.length > 0, "no workspace member was assessed");
        assert.deepEqual(members.filter((c) => c.lockfile !== "pnpm-lock.yaml").map((c) => `${c.path}: ${c.lockfile}`), []);
      });
      guard(`${name}: contract add can target the root app`, () => {
        const root = (auditFiles(run.repo).report?.components.included ?? []).find((c: { path: string }) => c.path === ".") as { id: string } | undefined;
        assert.ok(root, "the root app isn't a component");
        const repo = materialize(name, { now: NOW });
        assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
        assert.equal(readiness(repo, ["scan"]).code, 0);
        const r = readiness(repo, ["contract", "add", "--kind", "test", "--component", root.id, "--cmd", "node --test test/", "--reason", "the root app's tests", "--source", "package.json:6"]);
        assert.equal(r.code, 0, r.out);
      });
    }
    if (name === "pytest-optional-deps") {
      guard(`${name}: the install includes the extra that declares pytest`, () => {
        const contract = (auditFiles(run.repo).audit?.contract ?? []) as { kind: string; command: string }[];
        const installs = contract.filter((c) => c.kind === "install").map((c) => c.command);
        assert.ok(installs.some((c) => /\[test\]/.test(c)), `installs: ${JSON.stringify(installs)}`);
      });
    }
    if (name === "python-public-client-keys") {
      guard(`${name}: the provider-shaped key still blocks`, () => {
        assert.ok(run.obs.blocking.some((b) => b.file === "src/mediabot/settings.py"), `blocking: ${JSON.stringify(run.obs.blocking)}`);
      });
    }
  });
}
