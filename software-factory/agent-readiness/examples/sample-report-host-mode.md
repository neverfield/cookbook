# Agent readiness: healthy-node

> Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.

> **Action needed:** This audit ran without a container runtime, so Level 1 is unproven. Install Docker, or run it in CI, and rerun the audit.

## 1. Where am I now

**Unproven on this machine: no Level 1 check failed, and 3 were blocked here.**

**Level 1 couldn't be proved for healthy-node because this machine has no container runtime. A rerun where Docker is available, such as CI, can prove it.**

> **Next move:** Decision needed: where to rerun this audit so it can prove Level 1, for example a CI job. Also name an owner for agent readiness.

Level ladder: 0 Not bootable → 1 Bootable → 2 Verifiable → 3 Delegable → 4 Scalable (no level marked: this audit couldn't give one)

No level is marked: this audit couldn't give one. Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.

- **Components ready for agents:** 0 of 1. Level 2 needs 1 of 1.
- **Agent PRs that pass CI the first time:** not measured. Not measured yet: give the audit read access to pull requests, then rerun it to measure this.
- **Recent changes in components not yet proven at Level 2:** 100%. Proving Level 1 needs a clean container or a disposable VM; counting the last 90 days.

<details><summary>What this audit assumed</summary>

- **Components:** `.` (package.json).
- **Commands:** `npm ci` (install; from readiness); `npm run build` (build, healthy-node; from package.json scripts.build); `npm run lint` (lint, healthy-node; from package.json scripts.lint); `npm run test` (test, healthy-node; from package.json scripts.test).
- **Where they ran:** fresh copy on the host (no container runtime).
- **Toolchains the doctor found:** this machine: v22.14.0, 10.9.2.
- **Reruns:** every step that ran has a command in part 5 that reruns it from a clean checkout of dc50d7a.

</details>

## 2. Have I improved

This is the first audit, so there is nothing to compare yet. Rerun the audit after your first fix to see what changed here.

## 3. What moves the needle next

> **Recommendation:** Decision needed: where to rerun this audit so it can prove Level 1, for example a CI job. Also name an owner for agent readiness.

Next: Level 1, bootable. Blocked on this machine: healthy-node installs from the lockfile in a clean environment, healthy-node builds in a clean environment and healthy-node passes every test in a clean environment.

No actions are open: nothing in the repo blocks Level 1. Proving it needs a rerun where this machine's limits don't apply, such as CI with Docker.

## 4. Roadmap to the max level

0 of 2 steps done. Kept in `.agent-readiness/roadmap.json`.

### Level 1, bootable (later)

Level 1 needs: installs from the lockfile in a clean environment, builds in a clean environment and passes every test in a clean environment.

Its steps are added once the level below it is reached.

### Level 2, verifiable (later)

Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

Its steps are added once the level below it is reached.

### Level 3, delegable (later, experimental)

Level 3 means: agent PRs meet the outcome targets your team set, over at least 20 agent PRs in the window (never fewer than 10).

- [ ] Step 2: Set your Level 3 targets: unlocks a definition of Level 3 for this repo (later)

### Level 4, scalable (later, experimental)

Level 4 means: those targets held over two back-to-back windows while agent PR volume at least doubled.

Its steps are added once the level below it is reached.

### For every level

- [ ] Step 1: Name an owner for agent readiness: unlocks a named owner for approvals, targets and the weekly recheck (later)

## 5. Audit details: exact steps and everything we checked

### Measures

Confidence: low (a check that decides Level 1 was blocked on this machine).

- **Components ready for agents:** 0 of 1. Level 2 needs 1 of 1.
- **Agent PRs that pass CI the first time:** not measured. The audit needs read access to pull requests to compare agent PRs with other PRs.
- **Recent changes in components not yet proven at Level 2:** 100%. Proving Level 1 needs a clean container or a disposable VM; counting the last 90 days.

The level covers 1 component. Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host. Listed for review, not blocking: host mode was allowed: the repo's commands ran on this machine as this user, outside a container, with a throwaway home and no account credentials, but they could read this user's local files; it isn't a sandbox, and Level 1 can't be proved there.

### Everything we checked, and why

| Check | Why it matters | Result | Evidence |
|---|---|---|---|
| Components and where changes land (`scope.profile`) | Levels follow the work, so the audit finds each package and its share of recent changes. | 1 component found, 1 assessed |  |
| Agent assets in the repo (`scope.agent_assets`) | Shows what agent setup already exists and who maintains it. Not scored. | 1 asset, 1 author |  |
| Setup works from a clean checkout (`bootstrap.cold_replay`) | Every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. ([source](https://arxiv.org/abs/2605.15815)) | blocked on this machine: healthy-node | `ev-002`, `ev-003`, `ev-004`, `ev-006`, `ev-007`, `ev-008` |
| Build, lint, type-check and test commands pass (`verify.canonical_interface`) | Agents need one known way to check their own work, and a type-check counts only once the audit has seen it fail on a type error it planted. | passed: healthy-node | `ev-005`, `ev-006`, `ev-007` |
| Tests catch planted faults (`verify.behavioral_oracle`) | Green tests aren't proof that a change is right. OpenAI estimated about 30% of SWE-Bench Pro's 731 public tasks were broken, including low-coverage tests that let incomplete fixes pass. An audit of one benchmark, not of customer repositories. ([source](https://openai.com/index/separating-signal-from-noise-coding-evaluations)) | healthy-node: caught 5 of 5 planted faults | `ev-009` |
| Agent instructions are accurate (`context.instructions_verified`) | Agents follow AGENTS.md, rules and skills literally, so a stale command costs more than a missing one. No outcome study yet measures how much these files help. | 5 of 5 instruction items check out |  |
| Normal work needs no production access (`safety.execution_boundary`) | Agents run with whatever access setup gives them, so normal work must never need production credentials. | passed; 1 item listed for review | `ev-001` |

Not assessed by this rubric version, which is different from unknown: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, outcome checks on held-out tasks and whether the lint command catches anything.

### Levels by component

Repo shape: single. Each component gets one standard level; scenarios someone added appear under the components they cover.

| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |
|---|---|---|---|---|---|---|
| `healthy-node` | `.` | Node | `package.json` | `package-lock.json` | 100% | Unproven on this machine (could be 1) |

Repo level: Unproven on this machine (could be 1). The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it.

What keeps Level 1 unproven on this machine:

- `healthy-node`: installs from the lockfile in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM).
- `healthy-node`: builds in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM).
- `healthy-node`: passes every test in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM).

- **Standard level:** Level 1 needs: installs from the lockfile in a clean environment, builds in a clean environment and passes every test in a clean environment. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

### Agent PR outcomes

Not measured: outcomes need the external-systems tier and `readiness outcomes`.

### Agent assets already in the repo

| Asset | Path | Authors | Last changed | Status |
|---|---|---|---|---|
| agents_md | `AGENTS.md` | Contributor A | Jun 29 | Replays |

Missing: an environment setup, skills and hooks.

### Other signals (informational, not scored)

| Signal | Found | Detail |
|---|---|---|
| CI config | no | no GitHub Actions, GitLab CI, CircleCI or Buildkite config |
| A way to run one test file | yes | healthy-node: node --test takes file paths |
| Sample env file | n/a | the code reads no environment variables of its own |
| Worktree and port isolation | yes | no fixed ports or machine-specific absolute paths in the setup and scripts |
| AGENTS.md length | yes | 27 words |
| A scripted way to drive the app | n/a | no app to drive: no component has a start, dev, serve or preview script, a start command or a web framework |

These don't set a level. Only the drive-the-app signal can add a roadmap step: a later one, for a component already at Level 2.

### How each result was reached

Every level, every unproven or not-assessed result and every finding, with what ran, where it ran, what happened and the rule that produced the result.

#### Levels

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| repo | Unproven on this machine (could be 1) | the level rules over the active component, healthy-node | in a fresh copy on the host, because this machine has no container runtime | Set by healthy-node, held by healthy-node: installs from the lockfile in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM), healthy-node: builds in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM) and healthy-node: passes every test in a clean environment, blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM). | The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it. Unproven is a result of its own, not Level 0: no Level 1 check failed, and the ones left were blocked on this machine. |
| healthy-node | Unproven on this machine (could be 1) | `node --version && npm --version` (pass), `npm ci` (pass), `npm run build` (pass), `npm run lint` (pass) and `npm run test` (pass) | in a fresh copy on the host, with no container | Held unproven by installs from the lockfile in a clean environment: blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM), builds in a clean environment: blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM) and passes every test in a clean environment: blocked on this machine (passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM) | Level 1 needs: installs from the lockfile in a clean environment, builds in a clean environment and passes every test in a clean environment. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. A component's level is the highest whose conditions are all met; Level 3 and 4 also need agent PR outcomes against targets. Unproven is its own result: no Level 1 check failed, and the ones left were blocked on this machine. |

#### Conditions

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| healthy-node: installs from the lockfile in a clean environment | blocked on this machine | `npm ci` (pass) | in a fresh copy on the host, with no container | passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM | Level 1 needs it: installs from the lockfile in a clean environment (Setup works from a clean checkout). Blocked means a limit of this machine kept it from running; that never counts against the repo. |
| healthy-node: builds in a clean environment | blocked on this machine | `npm run build` (pass) | in a fresh copy on the host, with no container | passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM | Level 1 needs it: builds in a clean environment (Setup works from a clean checkout). Blocked means a limit of this machine kept it from running; that never counts against the repo. |
| healthy-node: passes every test in a clean environment | blocked on this machine | `npm run test` (pass) | in a fresh copy on the host, with no container | passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM | Level 1 needs it: passes every test in a clean environment (Setup works from a clean checkout). Blocked means a limit of this machine kept it from running; that never counts against the repo. |
| healthy-node: build, lint, type-check and test commands pass | met | `npm run lint` (pass), `npm run build` (pass) and `npm run test` (pass) | in a fresh copy on the host, with no container | 3 commands pass | Level 2 needs it: build, lint, type-check and test commands pass (Build, lint, type-check and test commands pass). Met means it ran at the strength the check requires and passed. A type-check that passes counts only once it fails on a known type error the audit adds, in a throwaway copy, to the most recently changed TypeScript or Python file the tests import, and passes again once the line is removed; a component whose tests import neither counts on the exit code alone. |
| healthy-node: tests catch planted faults | met | caught 5 of 5 planted faults (100%): strong, at least 57% with 97.5% confidence (tried: change_constant, shift_by_one, boundary_flip); a comment added to src/pricing.js left the tests passing | in a fresh copy on the host, with no container | caught 5 of 5 planted faults (100%): strong, at least 57% with 97.5% confidence (tried: change_constant, shift_by_one, boundary_flip); a comment added to src/pricing.js left the tests passing | Level 2 needs it: tests catch planted faults (Tests catch planted faults). Met means it ran at the strength the check requires and passed. |
| repo: agent instructions are accurate | met | `npm run lint` (pass), `npm run build` (pass) and `npm run test` (pass) | in a fresh copy on the host, with no container | 5 instruction items check out | Level 2 needs it: agent instructions are accurate (Agent instructions are accurate). Met means it ran at the strength the check requires and passed. |
| repo: normal work needs no production access | met | nothing ran for it | read from the audited commit's files, nothing ran | no blocking safety findings from 12 secret patterns over 8 files; 1 item listed for review | Level 2 needs it: normal work needs no production access (Normal work needs no production access). Met means it ran at the strength the check requires and passed. |
| repo: toolchain versions are pinned | met | nothing ran for it | read from the audited commit's files, nothing ran | pinned in .nvmrc | Reported with Level 1; no level waits on it alone: toolchain versions are pinned (Setup works from a clean checkout). Met means it ran at the strength the check requires and passed. |
| repo: a frozen install reproduces the lockfile | blocked on this machine | frozen install reproduced the lockfile | in a fresh copy on the host, with no container | passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container or a disposable VM | Reported with Level 1; no level waits on it alone: a frozen install reproduces the lockfile (Setup works from a clean checkout). Blocked means a limit of this machine kept it from running; that never counts against the repo. |

#### Agent instructions

<details><summary>Every instruction item</summary>

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| AGENTS.md:3 | checks out | checked that `src/pricing.js` exists | read from the audited commit's files, nothing ran | it exists | A file or folder the instructions name must exist in the repo, next to the instruction file, at the root or inside the package that owns it. |
| AGENTS.md:3 | checks out | checked that `test/` exists | read from the audited commit's files, nothing ran | it exists | A file or folder the instructions name must exist in the repo, next to the instruction file, at the root or inside the package that owns it. |
| AGENTS.md:5 | checks out | `npm test` | in a fresh copy on the host, with no container | it runs the same command as the test check, which passed | An instruction that runs the same command as a check the audit already ran takes that check's result, and a failure counts once, under the check, not again as a wrong instruction. |
| AGENTS.md:6 | checks out | `npm run build` | in a fresh copy on the host, with no container | it runs the same command as the build check, which passed | An instruction that runs the same command as a check the audit already ran takes that check's result, and a failure counts once, under the check, not again as a wrong instruction. |
| AGENTS.md:7 | checks out | `npm run lint` | in a fresh copy on the host, with no container | it runs the same command as the lint check, which passed | An instruction that runs the same command as a check the audit already ran takes that check's result, and a failure counts once, under the check, not again as a wrong instruction. |

</details>

#### Safety findings

| Result for | Result | What ran | Where it ran | What happened | Rule |
|---|---|---|---|---|---|
| this audit | listed for review | the repo's commands, in host mode | on the host, with --allow-host | host mode was allowed: the repo's commands ran on this machine as this user, outside a container, with a throwaway home and no account credentials, but they could read this user's local files; it isn't a sandbox, and Level 1 can't be proved there | Host mode runs the repo's commands on this machine as this user, so the report says it could read local files; it is never a sandbox. |

### Evidence log

<details><summary>All evidence</summary>

| ID | Check | Component | What ran | Result |
|---|---|---|---|---|
| `ev-001` | `safety.execution_boundary` | repo | (read from files) | pass: no blocking findings; 0 items listed for review |
| `ev-002` | `bootstrap.cold_replay` | repo | (read from files) | pass: toolchain pinned in .nvmrc |
| `ev-003` | `bootstrap.cold_replay` | repo | node --version && npm --version (ran on host, under 1 s) | pass: doctor passed |
| `ev-004` | `bootstrap.cold_replay` | repo | npm ci (ran on host, under 1 s) | pass: install passed |
| `ev-005` | `verify.canonical_interface` | healthy-node | npm run lint (ran on host, under 1 s) | pass: lint passed |
| `ev-006` | `bootstrap.cold_replay` | healthy-node | npm run build (ran on host, under 1 s) | pass: build passed |
| `ev-007` | `bootstrap.cold_replay` | healthy-node | npm run test (ran on host, under 1 s) | pass: test passed (5 of 5 tests) |
| `ev-008` | `bootstrap.cold_replay` | repo | (ran on host) | pass: frozen install reproduced the lockfile |
| `ev-009` | `verify.behavioral_oracle` | healthy-node | (ran on host) | pass: caught 5 of 5 planted faults (100%): strong, at least 57% with 97.5% confidence (tried: change_constant, shift_by_one, boundary_flip); a comment added to src/pr |

Rerun a step from a clean checkout of `dc50d7a`. Each command keeps the network on, where the audit ran tests and planted faults offline, and it writes into the folder it runs in: run it in a fresh clone, not your working checkout.

- `ev-003`: `bash -lc 'node --version && npm --version'`
- `ev-004`: `bash -lc 'npm ci'`
- `ev-005`: `bash -lc 'npm ci && npm run lint'`
- `ev-006`: `bash -lc 'npm ci && npm run build'`
- `ev-007`: `bash -lc 'npm ci && npm run build && npm run test'`

</details>

Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container or on a disposable VM, confirmed by outcomes. A check passes only at its required strength.

## About this report

Audited Oct 27, 2026 at dc50d7a. Eval run with a pinned seed; not a production result. Scripts match the agent-readiness-v0.2.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it.

- **Audit:** aud-2026-10-27-dc50d7a-58b8
- **Commit:** dc50d7a (clean tree)
- **Rubric:** 2026-12-beta
- **Permission tier:** local-exec
- **Seal:** Scripts match the agent-readiness-v0.2.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it
- **Integrity:** unsigned: the seal is a digest that shows edits, but anyone with the scripts could reseal an edited audit
- **Skill digest:** 5c068f8d692f
- **Planted faults:** seed pinned (eval run; not a production result)
- **Replay environment:** fresh copy on the host (no container runtime)
- **Environment self-check:** passed: mount visible, mount writable, run user, git identity
- **Host mode:** the repo's commands ran on this machine on the user's yes, recorded at 2026-10-27T15:00:00.000Z: "yes, run the tests on my laptop"
- **Stored in:** .agent-readiness/history/audits/aud-2026-10-27-dc50d7a-58b8

---

Generated from `report.json` by the agent-readiness skill; `report.html` is the same report as a page. For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs.
