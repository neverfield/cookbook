# Maintainer support

> Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.

This folder is for people who change the agent-readiness skill and need to validate those changes. End users only need the skill under `../skill/agent-readiness/` and the example reports under `../examples/`.

| Path | Purpose |
|---|---|
| `evals/` | Skill evals against `@cursor/sdk`, negative cases, baseline, METHOD.md, the hill-climb log HILLCLIMB.md, goldens and labels |
| `fixtures/` | Tiny repos with planted defects and `expected.json` (diagnostic ground truth) |
| `tools/` | Sample-report generator, fixture helpers, release-manifest writer, env-prefix scanner, CI skip check |
| `trials/` | Real public repos pinned at fixed commits, with each one's recorded result, target and false instruction finding ceiling |
| `examples/github-workflows/` | Example CI for static checks, scheduled recheck and skill evals |
| `AGENTS.md`, `PRODUCT.md`, `RELEASE.md` | Rules for changing the accelerator, product notes and release-gate policy |

## Commands (from the example root)

```bash
npm ci
npm run check
npm run trials             # needs Docker and network; about 10 minutes
npm run evals -- --tag smoke
npm run evals -- --tag negative
npm run goldens
npm run sample
npm run release-manifest   # after changing skill scripts, rubric, schemas or templates
npm run evals -- --release-check support/evals/runs/result.json
```

`npm run evals` needs a `CURSOR_API_KEY` for agent arms. Compare against `support/evals/baseline.json`. See [evals/README.md](evals/README.md) and [RELEASE.md](RELEASE.md).

## Pinned trial repos

`npm run trials` audits each repo in `trials/trials.json` at its pinned commit, with the skill copied into the repo as the quickstart does, a fixed seed and a fixed clock. A run fails when its result differs from the one recorded, or when its false instruction findings (failing items not listed in `realInstructionFindings`) rise above the recorded ceiling. After a change that moves a result on purpose, re-record with `SA_TRIALS_RECORD=1 npm run trials` and say why in the PR. `SA_TRIALS_TARGET=1` also asserts each trial's `target`, the correct answer from the Nov 14 reviews. `SA_TRIALS_ONLY=ms,zustand` runs a subset. Results that depend on blocked hosts (`egress`) are recorded separately for open and restricted networks.

CI (`.github/workflows/agent-readiness.yml` at the cookbook root) runs `npm run check` and `npm run trials` with Docker, and `tools/no-skips.sh` fails the run when any test or trial is skipped.
