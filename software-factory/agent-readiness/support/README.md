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
npm run trials             # needs Docker and network; about 10 minutes
npm run evals -- --tag smoke
npm run evals -- --tag negative
npm run goldens
npm run sample
npm run release-manifest   # after changing skill scripts, rubric, schemas or templates
npm run evals -- --release-check support/evals/runs/result.json
```

`npm run evals` needs a `CURSOR_API_KEY` for agent arms. Compare against `support/evals/baseline.json`. See [evals/README.md](evals/README.md) and [RELEASE.md](RELEASE.md).

## Adding a language

A language is one file in `../skill/agent-readiness/scripts/lib/languages/`, listed once in `index.ts`, implementing `LanguageDef` from `language.ts`. Nothing outside that folder should need to change. If a check elsewhere needs a fact about your language, add it to `LanguageChecks` in `language.ts` and give it in every language file instead of testing the language by name.

1. Copy the closest file: `go.ts` for a toolchain with its own image, `others.ts` for a language the scan recognizes but doesn't score. Set `id` (the file name), `label`, `codes` and `stacks`. A new code goes in the `Language` union in `scripts/lib/types.ts`, and a new ecosystem id in `PackageManager`. Both also go in the records in `tests/languages.test.ts`.
2. `detect`: the manifests and sources that make a folder a project, with ranks, and the lockfile names.
3. `ecosystems`: one per package manager, with its lockfiles, its frozen `install`, `unpinned`, and a `rule` sentence that matches its row in `references/levels.md`.
4. `checks`: every rule. Use `null` where the language has none, so the report says "not checked for <label>" instead of an all-clear:
   - `weakening.isTest` (the fault hooks' `isTest` when there are hooks) and `weakening.markers` (skip markers and test cases) for `readiness diff`
   - `lockfiles.diff` (changes `readiness diff` lists), `lockfiles.secretScanSkips` (`[]` when none), and `lockfiles.foreign` (the lockfile a PR adds when it switches package managers)
   - `manifestScripts` (install hooks, sudo, network pipes and deploys in the manifest's scripts)
   - `tool` (the first program of a command line that belongs to this language)
   - `countedTests` (the files that show the run plan a component has tests; the fault hooks' `isTest` when there are hooks)
5. `mutation`, or `null` when faults aren't planted: which files are tests and sources, which sources the tests cover, the fault sites on a line, the lines that are text rather than code, and how to tell a planted fault compiles. Without `sites` and `quoted`, the C-like rules in `fault-sites.ts` apply.
6. `replay`, required before any stack is `supported`: `classify`, `image` and `images` (each digest also goes in `scripts/lib/images.ts`), `doctor`, `pins` and `commands`.
7. Proof: a fixture under `fixtures/` with an `expected.json`, a `tests/lang-<id>.test.ts`, a pinned public repo in the stack's `proof`, and the stack's row in `references/supported.md`.
8. Run `npm run check`. `tests/languages.test.ts` fails if a rule is undeclared or has the wrong shape, if a code or ecosystem is missing from the unions, if a rubric counts a lockfile no language declares, or if a language file imports anything at runtime beyond its folder, `util.ts` and `patterns.ts`. Then run `npm run release-manifest`.

## Pinned trial repos

`npm run trials` audits each repo in `trials/trials.json` at its pinned commit, with the skill copied into the repo as the quickstart does, a fixed seed and a fixed clock. A run fails when its result differs from the one recorded, or when its false instruction findings (failing items not listed in `realInstructionFindings`) rise above the recorded ceiling. After a change that moves a result on purpose, re-record with `SA_TRIALS_RECORD=1 npm run trials` and say why in the PR. Each trial's truth, written from the repo and its upstream CI in the holdout's schema (`trials/truth/<id>.json`, see [holdout/PROTOCOL.md](holdout/PROTOCOL.md)), is scored on every run by the holdout's scorer, one guard per critical event and rate; a guard the tool doesn't meet yet is listed in `../tests/known-failures.json`. `SA_TRIALS_ONLY=ms,zustand` runs a subset. Results that depend on blocked hosts (`egress`) are recorded separately for open and restricted networks.

CI (`.github/workflows/agent-readiness.yml` at the cookbook root) runs `npm run check` and `npm run trials` with Docker, and `tools/no-skips.sh` fails the run when any test or trial is skipped.
