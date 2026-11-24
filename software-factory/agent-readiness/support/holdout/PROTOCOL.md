# Blind holdout protocol

How agent readiness is measured on public repositories that nobody who changes the tool has seen. This file, `truth.schema.json`, `record.schema.json`, `score.ts` and `thresholds.json` are frozen by digest in `frozen.json` before the first look. A test fails when any of them changes, except through the one amendment section 7 allows.

This folder names no holdout repository, and no file in this repository ever will. The repositories the tool is developed against are listed in `collision-log.json`, and the steward keeps every one of them out of the sets.

## 1. Roles

| Role | Who | Knows | Never |
| --- | --- | --- | --- |
| Steward | A run the owner starts outside the Project, with its own store that Project runs can't mount | The sets, the truth, every per-repo result | Writes or reviews product code, writes implementer assignments, suggests fixes, or puts free text into the repository |
| Truth writers | Two steward children of different model families that have never opened the tool's `scripts/lib/` | The holdout repositories and their upstream CI | See tool output before their truth is frozen |
| Coordinator and implementers | The Project | This protocol, the schemas, the scorer, the thresholds, the scorecards, the development set | Receive a holdout repository's name, owner, layout, path, report, or a paraphrase of one |
| Owner | Andrew | Anything he chooses to read | Relays it to the Project outside this protocol |

## 2. Selection

The steward pre-registers a query and a seed before drawing, and takes repositories in draw order without looking at their layout:

- strata by primary language over the supported ecosystems in `thresholds.json`, plus one stratum of unsupported stacks;
- a star band that leaves out the best-known projects, a push in the 90 days before the draw, a CI workflow, and a permissive license;
- one mechanical quota: a share of repositories with more than one manifest, counted from the tree listing;
- every repository in `collision-log.json` is skipped.

The draw fills validation (V), test (T) and reserve (R) sets of the sizes in `thresholds.json`: 12, 24 and 12. Each repository is pinned at its default branch head on the draw date.

## 3. Truth

For each repository at its pinned commit, each truth writer fills `truth.schema.json` from the repository and its upstream CI alone: the CI conclusion from the checks API, the install and test commands CI runs, the components by the repository's own workspace files, manifests and CODEOWNERS, the share of 90-day changes under each and under none, what the tests need, whether a clean install and the tests pass, which secret-shaped strings are real, and the next action. Change shares count (non-merge commit, changed file) pairs in the 90 days before the run's date, leaving out lockfiles, bot authors and commits that touch only lockfiles; a file belongs to the deepest listed path that holds it.

The two writers work independently. An item they disagree on is left out of every denominator, and the count goes in `dropped`. Truth is frozen before any tool output on that repository exists.

## 4. Commit and reveal

The steward publishes the SHA-256 of the salted manifest (every set's repositories, commits and truth) as a commitment record under `records/`, before PR B merges. A set's manifest and salt are revealed when the set is spent, so anyone can check that the set and its truth didn't change after results came in.

## 5. Runs

Each repository is audited by the scripted audit (`readiness audit --tier local-exec`) in two environments on the steward's machines:

- a container, with Docker;
- a disposable VM with no container runtime. The audit detects the VM itself; nothing declares it. Where the VM can't cut network access, Level 1 there is "proven with the network on", the report says so, and confidence is capped at medium. That is a stated difference for R5.

A fresh agent given only SKILL.md and "run an agent readiness audit" also audits the first `agentArmRepos` (8) repositories of T in draw order, once each, in the container environment.

`observe.ts` turns each run into an Observation. `score.ts` scores it against the truth. A run lost before any repository command, or to a registry 5xx, is rerun at most `infraRetries` (2) times; one still lost is left out and counted in `infraLost`. Any other lost run is a K4.

## 6. Looks and feedback

| Event | What the Project receives | Then |
| --- | --- | --- |
| V look (once, after PR E) | A record: counts by failure class and environment | V is spent: its manifest is revealed and its repositories join the trials with their truth. The thresholds may be amended once, here, with a written reason (section 7). |
| T attempt | A record: PASS or FAIL per threshold, and counts by class. Nothing else. | After a PASS, reruns on later commits are allowed and each is recorded. T is spent at its second FAIL, or at release. |
| Infra loss | A count | As section 5. |
| Collision or tripwire hit | A count | The repository is swapped for the next reserve repository, silently. |

No synthetic reproduction is made from T: each one teaches a shape. A class that can't be fixed from counts and public data takes its FAIL.

The steward's only channels are a pull request that contains only a record file matching `record.schema.json`, and PASS or FAIL with counts by class sent to the owner. Records hold enumerations, counts, hashes, commit ids and dates; `score.ts` refuses to write one with anything else.

## 7. Thresholds

`thresholds.json` holds them, and `score.ts` applies them.

**Critical events.** Any one in any run of T fails the attempt: K1 a Level 0 or "no tests" on a tested component that is green upstream and needs no service or network; K2 a level above the truth; K3 a blocking finding the truth doesn't list as real, or advice that would break the repository; K4 a crash, a hang past the budget or no sealed report; K5 after the audit, the repository's own test command refused, the tree changed outside `.agent-readiness/`, or containers or temp trees left behind; K6 one fact rendered with two values; K7 in the agent arm, a contract command the repository doesn't define or repository code run outside the scripts.

**Rates.** Each passes on its point estimate over T and is published with a 95% Wilson interval: R1 placement 0.875 (21 of 24), R2 test command 0.8, R3 proven level 0.7, R4 next action 0.8, R5 cross-environment agreement 0.9, R6 unowned share 0.9. R3 is the floor against passing by abstaining, and a rate with nothing to count fails.

Zero critical events in 24 repositories bounds the per-repository rate at about 12% (one-sided 95%). The release record states that number and claims no more. A model may know a public repository's layout from training; the star band and the pin at draw time reduce that and can't remove it, and the release record says so.

**Amendment.** Once, after the V look and before the first T attempt, `thresholds.json` may change. The change lands with an entry in `frozen.json`'s `amendments` that gives the date, the old and new digests and the reason. No other frozen file may change after the first look.

## 8. Checks on the blinding

- **Access test.** Before the draw, a Project run tries to list the steward store's path; the path must not exist for it.
- **Tripwire.** Each holdout file the steward keeps carries a canary string. Before an attempt counts, the steward searches the candidate diff, the PR text, the fixtures and the Project store for the canary, each repository's name and owner, and distinctive paths from the truth.
- **Collision log.** Everyone on the implementing side adds every public repository they run the tool on to `collision-log.json` (repository, commit, date, who, why), in the same pull request as the run, or straight after it when the run informs no change. The steward swaps out any collision.

## 9. Release

A release needs four records bound to the same scripts and rubric digests: `--release-check` PASS, a T attempt PASS, the journey and environment matrix green, and `tests/known-failures.json` empty.
