# Agent readiness: monorepo-mixed

> Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.

## 1. Where am I now

**Level 1 of 4, bootable.** Unchanged since Oct 30; 3 steps closed.

**Agents can build and test worker, but its tests can't yet catch wrong changes, and 23% of recent changes land there. api and shared are already at Level 2.**

> **Next move, step 5:** Make worker's tests catch wrong behavior. Takes worker to Level 2, covering 23% of recent changes. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand. Effort and owner: Medium: tests in worker only. Component owner. Decision: What the untested behavior in packages/worker/src/retry.js should be.

Level ladder: 0 Not bootable → **[1 Bootable]** → 2 Verifiable → 3 Delegable → 4 Scalable

Level 1 means: a clean checkout installs, builds and passes every test. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.

Trend: ▁▂▂▂▂▂ Oct 27 Level 0 → Oct 30 Level 1 → Nov 6 Level 1 (recheck) → Nov 13 Level 1 (recheck, failed) → Nov 20 Level 1 (recheck) → Nov 30 Level 1

- **Components ready for agents:** 2 of 3. Level 2 needs 3 of 3; last audit: 2 of 3.
- **Agent PRs that pass CI the first time:** 65% (11 of 17). Other PRs: 71% (27 of 38), Oct 31 to Nov 30, 2026.
- **Recent changes in components below Level 2:** 23%. Level 2 needs 0%; last audit: 25%, counting the last 90 days.

| Component | Level | Ladder 0 to 4 | Share of changes | Trend | What holds it |
|---|---|---|---|---|---|
| `api` | Level 2 | ○○●○○ | 53% | ▁▄▄▄▄▄ | ready for agents |
| `worker` | Level 1 | ○●○○○ | 23% | ▂▂▂▂▂▂ | tests catch planted faults: caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence (step 5) |
| `shared` | Level 2 | ○○●○○ | 14% | ▂▄▄▂▄▄ | ready for agents |
| `infra` | not assessed: Terraform isn't supported yet | | 0% | | |

Share of changes: the component's share of changed files over the last 90 days.

- **Not assessed:** infra (no recent changes), because Terraform isn't supported yet. What the audit supports: [supported.md](../skill/agent-readiness/references/supported.md).

<details><summary>What this audit assumed</summary>

- **Components:** `packages/api` (packages/api/package.json); `packages/shared` (packages/shared/package.json); `packages/worker` (packages/worker/package.json); `infra` (infra/main.tf), not assessed: Terraform isn't supported yet.
- **Commands:** `bash scripts/agent-install.sh` (install; from .cursor/environment.json install); `bash scripts/agent-start.sh` (start; from .cursor/environment.json start); `npm run lint` (lint, api, in packages/api; from packages/api/package.json scripts.lint); `npm run test` (test, api, in packages/api; from packages/api/package.json scripts.test); `npm run lint` (lint, shared, in packages/shared; from packages/shared/package.json scripts.lint); `npm run test` (test, shared, in packages/shared; from packages/shared/package.json scripts.test); `npm run lint` (lint, worker, in packages/worker; from packages/worker/package.json scripts.lint); `npm run test` (test, worker, in packages/worker; from packages/worker/package.json scripts.test).
- **Where they ran:** docker container, node:22-bookworm; the network is on for the install and build and switched off for tests, type-checks and planted faults, so a test that needs the internet fails here.
- **Toolchains the doctor found:** node:22-bookworm: v22.23.5, 10.9.9.
- **Reruns:** every step that ran has a command in part 5 that reruns it from a clean checkout of 9a2c092.

</details>

## 2. Have I improved

Since the audit on Oct 30, 2026:

- **Repo level:** Level 1 to Level 1, no change.
- No component level, condition or check changed.
- **Steps closed:** 2. Set up the service the tests expect on port 5432 for agents in api (Oct 30); 3. Fix the stale agent instructions (Oct 30); 4. Check api's tests with planted faults (Oct 30). Part 5 shows what moved after them.

## 3. What moves the needle next

> **Recommendation:** Decision needed: what the untested behavior in packages/worker/src/retry.js should be.

Next: Level 2, verifiable. Met: lint and test commands pass, agent instructions are accurate and normal work needs no production access. Not yet: worker tests catch planted faults.

1. **Make worker's tests catch wrong behavior.** Blocks Level 2 for worker.

### Step 5: Make worker's tests catch wrong behavior (do first)

- **How it moves the needle:** Takes worker to Level 2, covering 23% of recent changes. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand.
- **Why it matters:** The audit planted 11 faults in worker in a throwaway copy, and the tests caught 0.
- **Effort and owner:** Medium: tests in worker only. Component owner.
- **Decision needed:** What the untested behavior in packages/worker/src/retry.js should be.
- **Evidence:** `ev-015`

## 4. Roadmap to the max level

4 of 8 steps done. Kept in `.agent-readiness/roadmap.json`. Owner: Platform team.

### Level 1, bootable (reached)

Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container.

- [x] Step 2: Set up the service the tests expect on port 5432 for agents in api: unlocks api to Level 1 (done Oct 30)

### Level 2, verifiable (next)

Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

- [x] Step 3: Fix the stale agent instructions: unlocks shared to Level 2 (done Oct 30)
- [x] Step 4: Check api's tests with planted faults: unlocks nothing on its own; first needs Set up the service the tests expect on port 5432 for agents in api (done Oct 30)
- [ ] Step 5: Make worker's tests catch wrong behavior: unlocks worker to Level 2 (next)

### Level 3, delegable (later, experimental)

Level 3 means: agent PRs meet the outcome targets your team set, over at least 20 agent PRs in the window (never fewer than 10).

- [ ] Step 6: Set your Level 3 targets: unlocks a definition of Level 3 for this repo (later)
- [ ] Steps 7 to 8: Give agents work in api and shared: unlocks measured agent work in api and shared (in progress)

### Level 4, scalable (later, experimental)

Level 4 means: those targets held over two back-to-back windows while agent PR volume at least doubled.

Its steps are added once the level below it is reached.

### For every level

- [x] Step 1: Name an owner for agent readiness: unlocks a named owner for approvals, targets and the weekly recheck (done Oct 30)

## 5. Audit details: exact steps and everything we checked

### Measures

Confidence: high (every check that decides the level ran).

- **Components ready for agents:** 2 of 3. First audit: 0 of 3; last audit: 2 of 3.
- **Agent PRs that pass CI the first time:** 65% (11 of 17). Other PRs: 71% (27 of 38), Oct 31 to Nov 30, 2026.
- **Recent changes in components below Level 2:** 23%. First audit: 96%; last audit: 25%, counting the last 90 days.

The level covers 3 components and ignores infra (0% of changes, Terraform isn't supported yet). Tests and planted faults ran in a clean container with the network switched off, so a test that needs the internet fails here. Listed for review, not blocking: runs sudo; the audit runs it only inside a container, never on the host (scripts/agent-install.sh); runs sudo; the audit runs it only inside a container, never on the host (scripts/agent-start.sh). Agent PRs are matched by head branch starting with cursor/.

### Levels over time

| Date | Record | Repo | api | shared | worker |
|---|---|---|---|---|---|
| Oct 27 | audit | 0 | 0 | 1 | 1 |
| Oct 30 | audit | 1 | 2 | 2 | 1 |
| Nov 6 | recheck | 1 | 2 | 2 | 1 |
| Nov 13 | recheck failed, npm run lint failed: src/money.js: remove console.log | 1 | 2 | 1 | 1 |
| Nov 20 | recheck | 1 | 2 | 2 | 1 |
| Nov 30 | audit | 1 | 2 | 2 | 1 |

A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.

### What each closed step was expected to move, and what moved after it

| Step | Closed | Expected | Observed after |
|---|---|---|---|
| 2. Set up the service the tests expect on port 5432 for agents in api | Oct 30 | Agents can run api's checks before they push, so fewer agent PRs fail CI the first time. Watch: Share of agent PRs touching api that pass CI the first time, 20% (1 of 5). | 20% (1 of 5) to 78% (7 of 9) (closed with step 3 and step 4) |
| 3. Fix the stale agent instructions | Oct 30 | Agents stop following stale steps, such as running pnpm in a repo that doesn't use it. Watch: Agent PRs that add a stray pnpm-lock.yaml, 11% (1 of 9). | 11% (1 of 9) to 0% (0 of 17) (closed with step 2 and step 4) |
| 4. Check api's tests with planted faults | Oct 30 | Changes in api get a real pass-or-fail signal, so reviewers catch less by hand. Watch: Share of agent PRs touching api where a reviewer requested changes, 40% (2 of 5). | 40% (2 of 5) to 11% (1 of 9) (closed with step 2 and step 3) |

Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.

No test files changed since the last audit. No test files were deleted. No test cases were removed overall. No skip markers were added. The CI workflow is unchanged. The lockfile is unchanged.

Effort against impact (impact is the share of recent changes an action unblocks): 1. Make worker's tests catch wrong behavior (Do first: effort medium, 23%).

### Steps for Make worker's tests catch wrong behavior (step 5)

- **What to watch:** Share of agent PRs touching worker where a reviewer requested changes. Baseline: 2 of 3 (too few for a rate), Sep 27 to Oct 27, 2026. Now: 50% (3 of 6), Oct 31 to Nov 30, 2026.
- **Done when:** An audit after the change catches at least 60% of the faults it plants in worker.

1. **Decide the intended behavior.** For the files named here, write down what correct behavior is, including edge cases.
2. **Write tests that pin it down.** Assert results and edge cases, not just that code runs.
3. **Prove it with a new audit.** Run a new audit. Faults come from the code and the tests, so changing the tests plants different faults than this audit did, and tests aimed at one audit's faults don't help.
4. **Review.** `readiness diff` flags any deleted test or new skip marker, so nothing was weakened to pass.

### Everything we checked, and why

| Check | Why it matters | Result | Evidence |
|---|---|---|---|
| Components and where changes land (`scope.profile`) | Levels follow the work, so the audit finds each package and its share of recent changes. | 4 components found, 3 assessed |  |
| Agent assets in the repo (`scope.agent_assets`) | Shows what agent setup already exists and who maintains it. Not scored. | 5 assets, 3 authors |  |
| Setup works from a clean checkout (`bootstrap.cold_replay`) | Every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. ([source](https://arxiv.org/abs/2605.15815)) | passed: api, shared and worker | `ev-002`, `ev-003`, `ev-004`, `ev-008`, `ev-009`, `ev-010` and 2 more |
| Build, lint, type-check and test commands pass (`verify.canonical_interface`) | Agents need one known way to check their own work, and a type-check counts only once the audit has seen it fail on a type error it planted. | passed: api, shared and worker | `ev-005`, `ev-006`, `ev-007`, `ev-009`, `ev-010`, `ev-011` |
| Tests catch planted faults (`verify.behavioral_oracle`) | Green tests aren't proof that a change is right. OpenAI estimated about 30% of SWE-Bench Pro's 731 public tasks were broken, including low-coverage tests that let incomplete fixes pass. An audit of one benchmark, not of customer repositories. ([source](https://openai.com/index/separating-signal-from-noise-coding-evaluations)) | api: caught 5 of 5 planted faults; shared: caught 7 of 7 planted faults; worker: caught 0 of 11 planted faults | `ev-013`, `ev-014`, `ev-015` |
| Agent instructions are accurate (`context.instructions_verified`) | Agents follow AGENTS.md, rules and skills literally, so a stale command costs more than a missing one. No outcome study yet measures how much these files help. | 7 of 7 instruction items check out | `ev-016`, `ev-017`, `ev-018`, `ev-019`, `ev-020` |
| Normal work needs no production access (`safety.execution_boundary`) | Agents run with whatever access setup gives them, so normal work must never need production credentials. | passed; 2 items listed for review | `ev-001` |

Not assessed by this rubric version, which is different from unknown: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, outcome checks on held-out tasks and whether the lint command catches anything.

### Levels by component

Repo shape: monorepo. Each component gets one standard level; scenarios someone added appear under the components they cover.

| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |
|---|---|---|---|---|---|---|
| `api` | `packages/api` | Node | `packages/api/package.json` | `package-lock.json` | 53% | 2 Verifiable |
| `api` › Bug fixes | | | | | | 2 Verifiable |
| `shared` | `packages/shared` | Node | `packages/shared/package.json` | `package-lock.json` | 14% | 2 Verifiable |
| `shared` › Bug fixes | | | | | | 2 Verifiable |
| `worker` | `packages/worker` | Node | `packages/worker/package.json` | `package-lock.json` | 23% | 1 Bootable |
| `worker` › Bug fixes | | | | | | 1 Bootable |
| `infra` | `infra` | Terraform | `infra/main.tf` | none | 0% | not assessed: Terraform isn't supported yet |

Repo level: 1 Bootable. The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it.

What holds the repo at Level 1:

- `worker`: tests catch planted faults, not met (caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worker/src/retry.js:9, boundary_flip at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:5, boundary_flip at packages/worker/src/retry.js:12, swap_return at packages/worker/src/retry.js:10, change_constant at packages/worker/src/retry.js:3, negate_condition at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:12, negate_condition at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2).

- **Standard level:** Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.
- **Bug fixes scenario:** Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults and normal work needs no production access.

### Agent PR outcomes

Oct 31 to Nov 30, 2026. Agent PRs are matched by head branch starting with cursor/. Source: a recorded PR file.

| Measure | Agent PRs | Other PRs | Agent PRs, Sep 27 to Oct 27, 2026 |
|---|---|---|---|
| Opened | 17 | 38 | 9 |
| Merged | 77% (13 of 17) | 87% (33 of 38) | 78% (7 of 9) |
| Passed CI the first time | 65% (11 of 17) | 71% (27 of 38) | 33% (3 of 9) |
| Reviewer requested changes | 24% (4 of 17) | 16% (6 of 38) | 44% (4 of 9) |
| Median days to merge | 1 | 2 | 2 |
| Reverted within 14 days | 8% (1 of 13) | 3% (1 of 33) | 14% (1 of 7) |

| Component | Agent PRs | Passed CI the first time | Changes requested |
|---|---|---|---|
| `api` | 9 | 78% (7 of 9) | 11% (1 of 9) |
| `shared` | 3 | 3 of 3 (too few for a rate) | 0 of 3 (too few for a rate) |
| `worker` | 6 | 33% (2 of 6) | 50% (3 of 6) |

1 agent PR touched more than one component, so the component rows can add up to more than the total. A trend, not attribution. Model updates or a different mix of tasks could account for part of the change.

Matched PRs: #500, #501, #502, #503, #504, #505, #506, #507, #508, #509, #510, #511, #512, #513, #514, #515, #516.

Reverted within 14 days counts merged PRs whose first revert landed within 14 days of the merge. A revert is a merged PR whose body says "Reverts #123" or whose title is Revert "<the PR's title>", or a commit on the default branch that says "This reverts commit <the merge commit>"; a revert squashed without that line isn't seen, so these are detected reverts. 4 of the merged agent PRs merged less than 14 days before the window ended, so they had less time to be reverted. Reported only: no level or target uses it yet. Reverted agent PRs: #512 (by #912).

### Agent assets already in the repo

| Asset | Path | Authors | Last changed | Status |
|---|---|---|---|---|
| environment | `.cursor/environment.json` | Contributor B | Oct 29 | Present |
| rules | `.cursor/rules/style.mdc` | Contributor A | Jun 29 | Replays |
| skill | `.cursor/skills/release-notes/SKILL.md` | Contributor A, Contributor B, Contributor C | Oct 29 | Present |
| skill | `.cursor/skills/verify/SKILL.md` | Contributor B | Oct 30 | Replays |
| agents_md | `AGENTS.md` | Contributor B, Contributor A | Oct 29 | Replays |

Missing: hooks.

### Other signals (informational, not scored)

| Signal | Found | Detail |
|---|---|---|
| CI config | yes | .github/workflows/ci.yml, and it runs tests |
| A way to run one test file | yes | api: node --test takes file paths; shared: node --test takes file paths; worker: node --test takes file paths |
| Sample env file | n/a | the code reads no environment variables of its own |
| Worktree and port isolation | yes | no fixed ports or machine-specific absolute paths in the setup and scripts |
| AGENTS.md length | yes | 35 words |
| A scripted way to drive the app | n/a | no app to drive: no component has a start, dev, serve or preview script, a start command or a web framework |

These don't set a level. Only the drive-the-app signal can add a roadmap step: a later one, for a component already at Level 2.

### How each result was reached

Every level, every unproven or not-assessed result and every finding, with what ran, where it ran, what happened and the rule that produced the result.

#### Levels

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| repo | Level 1 | the level rules over the active components, api, shared and worker | in a clean docker container (node:22-bookworm) | Set by worker, held by worker: tests catch planted faults, not met (caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worker/src/retry.js:9, boundary_flip at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:5, boundary_flip at packages/worker/src/retry.js:12, swap_return at packages/worker/src/retry.js:10, change_constant at packages/worker/src/retry.js:3, negate_condition at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:12, negate_condition at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2). | The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it. |
| api | Level 2 | `node --version && npm --version` (pass), `bash scripts/agent-install.sh` (pass), `npm ci` (not run), `bash scripts/agent-start.sh` (pass), `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | Held at Level 2 by agent PRs meet the team's targets: not met (no Level 3 targets are recorded) | Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. A component's level is the highest whose conditions are all met; Level 3 and 4 also need agent PR outcomes against targets. |
| shared | Level 2 | `node --version && npm --version` (pass), `bash scripts/agent-install.sh` (pass), `npm ci` (not run), `bash scripts/agent-start.sh` (pass), `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | Held at Level 2 by agent PRs meet the team's targets: not met (no Level 3 targets are recorded) | Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. A component's level is the highest whose conditions are all met; Level 3 and 4 also need agent PR outcomes against targets. |
| worker | Level 1 | `node --version && npm --version` (pass), `bash scripts/agent-install.sh` (pass), `npm ci` (not run), `bash scripts/agent-start.sh` (pass), `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | Held at Level 1 by tests catch planted faults: not met (caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worker/src/retry.js:9, boundary_flip at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:5, boundary_flip at packages/worker/src/retry.js:12, swap_return at packages/worker/src/retry.js:10, change_constant at packages/worker/src/retry.js:3, negate_condition at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:12, negate_condition at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2) | Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. A component's level is the highest whose conditions are all met; Level 3 and 4 also need agent PR outcomes against targets. |
| infra | not assessed | nothing: the audit runs commands only for assessed components | not run | Terraform isn't supported yet | Only components on a supported toolchain are assessed, up to the 10 most active by share of recent changes; the support list says which toolchains are supported. |

#### Conditions

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| api: installs from the lockfile in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | install passed | Level 1 needs it: installs from the lockfile in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| api: builds in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | no build step; follows the install | Level 1 needs it: builds in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| api: passes every test in a clean container | met | `npm run test` (pass) | in a clean docker container (node:22-bookworm) | test passed (1 of 1 tests) | Level 1 needs it: passes every test in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. Tests run with the container's network switched off, so a test that needs the internet fails. |
| api: build, lint, type-check and test commands pass | met | `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | 2 commands pass | Level 2 needs it: build, lint, type-check and test commands pass (Build, lint, type-check and test commands pass). Met means it ran at the strength the check requires and passed. A type-check that passes counts only once it fails on a known type error the audit adds, in a throwaway copy, to the most recently changed TypeScript or Python file the tests import, and passes again once the line is removed; a component whose tests import neither counts on the exit code alone. |
| api: tests catch planted faults | met | caught 5 of 5 planted faults (100%), 5 of them planted again from the last audit: strong, at least 57% with 97.5% confidence (tried: negate_condition, change_constant, drop_throw_or_return, boundary_flip) | in a clean docker container (node:22-bookworm) | caught 5 of 5 planted faults (100%), 5 of them planted again from the last audit: strong, at least 57% with 97.5% confidence (tried: negate_condition, change_constant, drop_throw_or_return, boundary_flip) | Level 2 needs it: tests catch planted faults (Tests catch planted faults). Met means it ran at the strength the check requires and passed. Tests run with the container's network switched off, so a test that needs the internet fails. |
| repo: agent instructions are accurate | met | `npm run lint -w api` (pass), `npm run test -w shared` (pass), `npm test` (pass) `node --version && npm --version` (pass), and 1 more | in a clean docker container (node:22-bookworm) | 7 instruction items check out | Level 2 needs it: agent instructions are accurate (Agent instructions are accurate). Met means it ran at the strength the check requires and passed. |
| repo: normal work needs no production access | met | nothing ran for it | read from the audited commit's files, nothing ran | no blocking safety findings from 12 secret patterns over 38 files; 2 items listed for review | Level 2 needs it: normal work needs no production access (Normal work needs no production access). Met means it ran at the strength the check requires and passed. |
| repo: toolchain versions are pinned | met | nothing ran for it | read from the audited commit's files, nothing ran | pinned in .nvmrc | Reported with Level 1; no level waits on it alone: toolchain versions are pinned (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| repo: a frozen install reproduces the lockfile | met | frozen install reproduced the lockfile | in a clean docker container (node:22-bookworm) | frozen install reproduced the lockfile | Reported with Level 1; no level waits on it alone: a frozen install reproduces the lockfile (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| shared: installs from the lockfile in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | install passed | Level 1 needs it: installs from the lockfile in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| shared: builds in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | no build step; follows the install | Level 1 needs it: builds in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| shared: passes every test in a clean container | met | `npm run test` (pass) | in a clean docker container (node:22-bookworm) | test passed (3 of 3 tests) | Level 1 needs it: passes every test in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. Tests run with the container's network switched off, so a test that needs the internet fails. |
| shared: build, lint, type-check and test commands pass | met | `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | 2 commands pass | Level 2 needs it: build, lint, type-check and test commands pass (Build, lint, type-check and test commands pass). Met means it ran at the strength the check requires and passed. A type-check that passes counts only once it fails on a known type error the audit adds, in a throwaway copy, to the most recently changed TypeScript or Python file the tests import, and passes again once the line is removed; a component whose tests import neither counts on the exit code alone. |
| shared: tests catch planted faults | met | caught 7 of 7 planted faults (100%), 7 of them planted again from the last audit: strong, at least 65% with 97.5% confidence (tried: negate_condition, drop_throw_or_return, boundary_flip, change_constant) | in a clean docker container (node:22-bookworm) | caught 7 of 7 planted faults (100%), 7 of them planted again from the last audit: strong, at least 65% with 97.5% confidence (tried: negate_condition, drop_throw_or_return, boundary_flip, change_constant) | Level 2 needs it: tests catch planted faults (Tests catch planted faults). Met means it ran at the strength the check requires and passed. Tests run with the container's network switched off, so a test that needs the internet fails. |
| worker: installs from the lockfile in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | install passed | Level 1 needs it: installs from the lockfile in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| worker: builds in a clean container | met | `bash scripts/agent-install.sh` (pass) | in a clean docker container (node:22-bookworm) | no build step; follows the install | Level 1 needs it: builds in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| worker: passes every test in a clean container | met | `npm run test` (pass) | in a clean docker container (node:22-bookworm) | test passed (2 of 2 tests) | Level 1 needs it: passes every test in a clean container (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. Tests run with the container's network switched off, so a test that needs the internet fails. |
| worker: build, lint, type-check and test commands pass | met | `npm run lint` (pass) and `npm run test` (pass) | in a clean docker container (node:22-bookworm) | 2 commands pass | Level 2 needs it: build, lint, type-check and test commands pass (Build, lint, type-check and test commands pass). Met means it ran at the strength the check requires and passed. A type-check that passes counts only once it fails on a known type error the audit adds, in a throwaway copy, to the most recently changed TypeScript or Python file the tests import, and passes again once the line is removed; a component whose tests import neither counts on the exit code alone. |
| worker: tests catch planted faults | not met | caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worker/src/retry.js:9, boundary_flip at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:5, boundary_flip at packages/worker/src/retry.js:12, swap_return at packages/worker/src/retry.js:10, change_constant at packages/worker/src/retry.js:3, negate_condition at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:12, negate_condition at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2 | in a clean docker container (node:22-bookworm) | caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worker/src/retry.js:9, boundary_flip at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:5, boundary_flip at packages/worker/src/retry.js:12, swap_return at packages/worker/src/retry.js:10, change_constant at packages/worker/src/retry.js:3, negate_condition at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:12, negate_condition at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2 | Level 2 needs it: tests catch planted faults (Tests catch planted faults). Not met means it ran and failed, or the repo lacks what it needs. Tests run with the container's network switched off, so a test that needs the internet fails. |

#### Agent instructions

<details><summary>Every instruction item</summary>

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| .cursor/rules/style.mdc:6 | checks out | `npm run lint -w api` | in a clean docker container (node:22-bookworm) | it exited 0 | A command that passes the static checks runs in a copy of the repo and must exit 0. |
| AGENTS.md:3 | checks out | checked that `packages/` exists | read from the audited commit's files, nothing ran | it exists | A file or folder the instructions name must exist in the repo, next to the instruction file, at the root or inside the package that owns it. |
| AGENTS.md:5 | checks out | `npm ci` | read from the audited commit's files, nothing ran | install commands are checked statically; the clean replay runs the frozen install | Install commands are checked statically; the clean replay runs the frozen install instead. |
| AGENTS.md:6 | checks out | `npm run test -w shared` | in a clean docker container (node:22-bookworm) | it exited 0 | A command that passes the static checks runs in a copy of the repo and must exit 0. |
| AGENTS.md:7 | checks out | `npm test` | in a clean docker container (node:22-bookworm) | it exited 0 | A command that passes the static checks runs in a copy of the repo and must exit 0. |
| .cursor/skills/verify/SKILL.md:15 | checks out | `node --version && npm --version` | in a clean docker container (node:22-bookworm) | it exited 0 | A command that passes the static checks runs in a copy of the repo and must exit 0. |
| .cursor/skills/verify/SKILL.md:56 | checks out | `npm run test` | in a clean docker container (node:22-bookworm) | it exited 0 | A command that passes the static checks runs in a copy of the repo and must exit 0. |

</details>

#### Safety findings

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| scripts/agent-install.sh | listed for review | the secret and script scan | read from the audited commit's files, nothing ran | runs sudo; the audit runs it only inside a container, never on the host | A setup step or script that uses sudo is listed for review; the audit runs it only inside a container. |
| scripts/agent-start.sh | listed for review | the secret and script scan | read from the audited commit's files, nothing ran | runs sudo; the audit runs it only inside a container, never on the host | A setup step or script that uses sudo is listed for review; the audit runs it only inside a container. |

### Evidence log

<details><summary>All evidence</summary>

| ID | Check | Component | What ran | Result |
|---|---|---|---|---|
| `ev-001` | `safety.execution_boundary` | repo | (read from files) | pass: no blocking findings; 2 items listed for review |
| `ev-002` | `bootstrap.cold_replay` | repo | (read from files) | pass: toolchain pinned in .nvmrc |
| `ev-003` | `bootstrap.cold_replay` | repo | node --version && npm --version (ran in a clean container, under 1 s) | pass: doctor passed |
| `ev-004` | `bootstrap.cold_replay` | repo | bash scripts/agent-install.sh (ran in a clean container, 9 s) | pass: install passed |
| `ev-005` | `verify.canonical_interface` | api | npm run lint (ran in a clean container, under 1 s) | pass: lint passed |
| `ev-006` | `verify.canonical_interface` | shared | npm run lint (ran in a clean container, under 1 s) | pass: lint passed |
| `ev-007` | `verify.canonical_interface` | worker | npm run lint (ran in a clean container, under 1 s) | pass: lint passed |
| `ev-008` | `bootstrap.cold_replay` | repo | bash scripts/agent-start.sh (ran in a clean container, 2 s) | pass: start passed |
| `ev-009` | `bootstrap.cold_replay` | api | npm run test (ran in a clean container, under 1 s) | pass: test passed (1 of 1 tests) |
| `ev-010` | `bootstrap.cold_replay` | shared | npm run test (ran in a clean container, under 1 s) | pass: test passed (3 of 3 tests) |
| `ev-011` | `bootstrap.cold_replay` | worker | npm run test (ran in a clean container, under 1 s) | pass: test passed (2 of 2 tests) |
| `ev-012` | `bootstrap.cold_replay` | repo | (ran in a clean container) | pass: frozen install reproduced the lockfile |
| `ev-013` | `verify.behavioral_oracle` | api | (ran in a clean container) | pass: caught 5 of 5 planted faults (100%), 5 of them planted again from the last audit: strong, at least 57% with 97.5% confidence (tried: negate_condition, change_co |
| `ev-014` | `verify.behavioral_oracle` | shared | (ran in a clean container) | pass: caught 7 of 7 planted faults (100%), 7 of them planted again from the last audit: strong, at least 65% with 97.5% confidence (tried: negate_condition, drop_thro |
| `ev-015` | `verify.behavioral_oracle` | worker | (ran in a clean container) | fail: caught 0 of 11 planted faults (0%), 10 of them planted again from the last audit: weak, at most 20% with 95% confidence; missed: boundary_flip at packages/worke |
| `ev-016` | `context.instructions_verified` | repo | npm run lint -w api (ran in a clean container, under 1 s) | pass: .cursor/rules/style.mdc:6 `npm run lint -w api` replays |
| `ev-017` | `context.instructions_verified` | repo | npm run test -w shared (ran in a clean container, under 1 s) | pass: AGENTS.md:6 `npm run test -w shared` replays |
| `ev-018` | `context.instructions_verified` | repo | npm test (ran in a clean container, under 1 s) | pass: AGENTS.md:7 `npm test` replays |
| `ev-019` | `context.instructions_verified` | repo | node --version && npm --version (ran in a clean container, under 1 s) | pass: .cursor/skills/verify/SKILL.md:15 `node --version && npm --version` replays |
| `ev-020` | `context.instructions_verified` | repo | npm run test (ran in a clean container, under 1 s) | pass: .cursor/skills/verify/SKILL.md:56 `npm run test` replays |

Rerun a step from a clean checkout of `9a2c092`:

- `ev-003`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'node --version && npm --version'`
- `ev-004`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh'`
- `ev-005`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/api && npm run lint)'`
- `ev-006`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/shared && npm run lint)'`
- `ev-007`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/worker && npm run lint)'`
- `ev-008`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && bash scripts/agent-start.sh'`
- `ev-009`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/api && npm run test)'`
- `ev-010`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/shared && npm run test)'`
- `ev-011`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && (cd packages/worker && npm run test)'`
- `ev-016`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && npm run lint -w api'`
- `ev-017`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && npm run test -w shared'`
- `ev-018`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && npm test'`
- `ev-019`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && node --version && npm --version'`
- `ev-020`: `docker run --rm -v "$PWD":/work -w /work node:22-bookworm bash -lc 'bash scripts/agent-install.sh && npm run test'`

</details>

Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.

## About this report

Audited Nov 30, 2026 at 9a2c092. Eval run with a pinned seed; not a production result. Outcomes come from a recorded PR file, not GitHub; not a production result. Scripts match the agent-readiness-v0.2.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it.

- **Audit:** aud-2026-11-30-9a2c092-ae7a
- **Commit:** 9a2c092 (clean tree)
- **Rubric:** 2026-12-beta
- **Permission tier:** local-exec
- **Seal:** Scripts match the agent-readiness-v0.2.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it
- **Integrity:** unsigned: the seal is a digest that shows edits, but anyone with the scripts could reseal an edited audit
- **Skill digest:** ed44533b343a
- **Planted faults:** seed pinned (eval run; not a production result)
- **Replay environment:** docker container, node:22-bookworm; the network is on for the install and build and switched off for tests, type-checks and planted faults, so a test that needs the internet fails here
- **Environment self-check:** passed: mount visible, mount writable, run user, git identity, network cut
- **Stored in:** .agent-readiness/history/audits/aud-2026-11-30-9a2c092-ae7a

---

Generated from `report.json` by the agent-readiness skill; `report.html` is the same report as a page. For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs.
