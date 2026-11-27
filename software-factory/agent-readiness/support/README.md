# Maintainer support

> Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.

This folder is for people who change the agent-readiness skill and need to validate those changes. End users only need the skill under `../skill/agent-readiness/` and the example reports under `../examples/`.

| Path | Purpose |
|---|---|
| `evals/` | Skill evals against `@cursor/sdk`, negative cases, baseline, METHOD.md, the hill-climb log HILLCLIMB.md, goldens and labels |
| `fixtures/` | Tiny repos with planted defects and `expected.json` (diagnostic ground truth), or `truth.json` in the holdout's schema for guard fixtures whose fix hasn't landed |
| `holdout/` | The blind holdout's frozen protocol, schemas, scorer and thresholds, the adapter from a report to an observation, and the collision log; no holdout repository is named here |
| `tools/` | Sample-report generator, fixture helpers, release-manifest writer, env-prefix scanner, CI skip check, known-failures harness, instrument-freeze check |
| `trials/` | Real public repos pinned at fixed commits, with each one's recorded result, truth (`truth/<id>.json`) and false instruction finding ceiling |
| `examples/github-workflows/` | Example CI for static checks, scheduled recheck and skill evals |
| `AGENTS.md`, `PRODUCT.md`, `RELEASE.md` | Rules for changing the accelerator, product notes and release-gate policy |

## Commands (from the example root)

```bash
npm ci
npm run check
npm run trials             # needs Docker and network; about 3 hours serial, or SA_TRIALS_SHARD=k/3 for one shard of about an hour
npm run evals -- --tag smoke
npm run evals -- --tag negative
npm run goldens
npm run sample
npm run release-manifest   # after changing skill scripts, rubric, schemas or templates
npm run evals -- --release-check support/evals/runs/result.json
```

`npm run evals` needs a `CURSOR_API_KEY` for agent arms. Compare against `support/evals/baseline.json`. See [evals/README.md](evals/README.md) and [RELEASE.md](RELEASE.md).

## Pinned trial repos

`npm run trials` audits each repo in `trials/trials.json` at its pinned commit, with the skill copied into the repo as the quickstart does, a fixed seed and a fixed clock. A run fails when its result differs from the one recorded, or when its false instruction findings (failing items not listed in `realInstructionFindings`) rise above the recorded ceiling. After a change that moves a result on purpose, re-record with `SA_TRIALS_RECORD=1 npm run trials` and say why in the PR. Each trial's truth, written from the repo and its upstream CI in the holdout's schema (`trials/truth/<id>.json`, see [holdout/PROTOCOL.md](holdout/PROTOCOL.md)), is scored on every run by the holdout's scorer, one guard per critical event and rate; a guard the tool doesn't meet yet is listed in `../tests/known-failures.json`. `SA_TRIALS_ONLY=zustand,zap` runs a subset. Results that depend on blocked hosts (`egress`) are recorded separately for open and restricted networks.

A trial's other fields:

- `tier: "read-only"` scans a repo too large to audit in the run, without running its code. Its truth still scores discovery, placement, test commands, the unowned share and safety findings; R3 needs a container run, so it counts nothing there.
- `tracking` maps a truth guard to why it misses: the guard prints `tracking miss: <trial> <guard> (<why>): ...` and doesn't fail the run. It is only for a miss that comes from a feature the tool doesn't support yet, such as task-graph builds, and such a guard is never listed in `known-failures.json`. A tracking guard that meets its truth prints that it can leave tracking.
- `alsoRun` audits the trial again with no container runtime (`none`, the same on every machine) or in host mode (`host`, recorded by the environment the audit reports: `host/disposable_vm` on a Cursor Cloud Agent VM, `host/host` elsewhere). A machine with no host-mode result recorded for its environment prints what it saw instead of failing.
- `minutes` is the wall time of the trial's audits when last recorded. `SA_TRIALS_SHARD=k/n` runs the k-th of n shards, split by these minutes (`trials/shards.ts`); `SA_TRIALS_RECORD=minutes` checks every result as usual and rewrites only the minutes.
- `budgetEdge` marks a trial whose result a time budget decides. Shards started side by side on one machine share a lock in `SA_TRIALS_CACHE`: `SA_TRIALS_HOST_SLOTS` audits run at once (1 by default), and a `budgetEdge` trial waits until it runs alone. Shards on separate machines, as in CI, don't affect each other.

CI (`.github/workflows/agent-readiness.yml` at the cookbook root) runs `npm run check`, and `npm run trials` in three shards on separate runners, with Docker, and `tools/no-skips.sh` fails the run when any test or trial is skipped.
