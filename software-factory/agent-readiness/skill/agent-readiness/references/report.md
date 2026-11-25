# The report

> Preview: agent-readiness 0.2 is pre-1.0; results and scoring may change.

`readiness seal` writes `report.json` (schema `agent-readiness/report@1`), the view model, and two views of it: `report.md` and `report.html`, a self-contained page with inline CSS and SVG and no scripts. The seal covers all three. Every number comes from computed fields. Any other renderer, such as a dashboard or a canvas, reads `report.json` and hardcodes nothing, not even component names.

## The three tiers in `report.json`

1. `maturity`: the repo rollup, with `level`, the `rule` that produced it, `setBy`, `outcome` (`proven`, `blocked` or `not_assessed`), `confidence` and `capReasons`.
2. `components.included[]`: each assessed component's standard `level` (null when the audit has no real results), its `capReasons`, and `scenarios[]` nested under it. `components.excluded[]` lists every component left out, with the reason.

The repo level and every component's level also carry `status` (`proven`, `unproven`, `undetermined` or `not_assessed`), `provenIn` (where a proven level was shown, such as `container`) and `settleBy` (what would settle a result that isn't proven, with its kind and one sentence). An unproven result is no level: every view says "Unproven on this machine" and the ladder marks nothing.
3. `components.included[].scenarios[]`: present only for scenarios someone added. `scenarios` at the top says which were added and for which components.

## The parts

The executive fields (heading, headline, numbers, next-level line, gaps, ask and coverage) are what the part 1 rules below govern; the views place them where the reader needs them.

Until 1.0, `preview` holds the skill's Preview label, quoted at the top of this page, and both views show it under the title, above part 1. It comes from `scripts/lib/preview.ts` and never changes a level or score.

1. **Where am I now.** One screen, written like an executive slide, holding only what the reader acts on:
   - A notice only when the reader should act, phrased as the action (for example "This audit ran without a container runtime, so Level 1 is unproven. Install Docker or Podman, or run it in CI, and rerun the audit."). Integrity, provenance and eval-mode notes are in "About this report" at the end.
   - The heading: the repo level with its plain meaning, for example "Level 0 of 4, not bootable", or "Unproven on this machine: no Level 1 check failed, and 3 were blocked here" when this machine couldn't check Level 1; that count is the blocked checks the components hold. It names no activity. One line on what changed since the last audit follows it.
   - The headline: one message.
   - The next move: the first step, what it unlocks, its effort and owner, and its decision.
   - The level ladder with the repo marked on it, what the marked level means and what the next one needs, and the trend of the repo level once there are three or more records. Levels 3 and 4 are labelled experimental: this version doesn't validate them end to end, so Level 2 is its proven top.
   - Three numbers, each compared with what the next level needs; one that isn't measured says how to measure it. The sealed comparisons are in part 5.
   - What isn't assessed and why, with a link to the supported stacks.
   - For a monorepo, each component with its level, change share, trend and what holds it, with the step that moves it.
   - What the audit assumed, folded: the component map, each command with the file it came from, where the commands ran, and the toolchain versions the doctor printed there.
2. **Have I improved.** From the second audit on, what changed since the last audit, read from its sealed report: level changes, conditions now met or now failing, and checks that flipped. Then levels over time, what each closed step was expected to deliver against what it did, and the weakened-test check. A first audit says there is nothing to compare yet.
3. **What moves the needle next.** The one ask first; one line on what the next level still needs; at most three gaps, one plain line each; one ask, the single decision that unblocks the top gap, plus naming an owner when none is recorded; an effort-against-impact view; then each step, numbered as in the roadmap: why it matters, the level it unlocks and the share of recent changes that covers, the metric to watch with its baseline, any verified research, effort and owner role, the decision needed, the evidence it was raised from, and a re-runnable "done when". A "can start now" action follows when some component is already ready.
4. **Roadmap to the max level.** Each level from 1 to 4 with what it needs and its steps, each with its status (done, in progress, next, can start now, waiting on step N, later), then the steps that serve every level.
5. **Audit details.** The three numbers with their sealed comparisons, the confidence, the coverage note and the history; exact steps for each action; every check with why it matters, its result with exact counts, and its evidence IDs; what isn't assessed; levels by component, with any scenarios nested under each, and the repo level with its rule; agent PR outcomes; agent assets; how each result was reached; the waivers; the evidence log. Each evidence row has how long it took and a command that reruns it from a clean checkout of the audited commit. When a step ran again, as in a second replay, the new row is the result and the old one is folded under it as superseded; counts and conditions read only the current rows.

## How each result was reached

`report.json` `explanations[]` holds one entry for the repo level, each component's level, each component left out, each condition of each assessed component, each instruction item and each safety finding. Every entry says what ran, where it ran (a clean container and its image, a fresh copy on the host, or the audited commit's files with nothing run), what happened, and the rule that produced the result. Part 5 prints them as tables. The seal refuses a report in which any result lacks one of these, or reads "undefined".

When most recent changes sit in components the audit doesn't assess, such as a Go backend next to a small web UI, the heading says how much of the repo the level covers.

## Waivers

A repo lists findings it has reviewed as false positives in `.agent-readiness/waivers.json`:

```json
{
  "schema": "agent-readiness/waivers@1",
  "waivers": [
    { "id": "readme-install", "check": "context.instructions_verified", "match": "README.md:72", "reason": "Install line for the package's users", "by": "Contributor A", "expires": "2027-05-15" }
  ]
}
```

- Only `context.instructions_verified` and `safety.execution_boundary` findings can be waived. A waiver that names a Level 1 check is refused.
- `match` is a file and line, or a file for every finding in it. `reason` and `by` are required; `expires` is optional, and an expired waiver is refused. At most 50 waivers count.
- The audit reads the file from the audited commit only. A copy edited during the audit, by the agent or anyone else, doesn't count, and the report says so. The agent never writes this file.
- A waived finding stops counting, keeps what it was, and is listed in part 5 with the waiver's reason and reviewer. Part 5 also lists waivers that matched nothing and waivers that were refused. The coverage note counts the waived findings. The waivers are sealed with the audit.
6. **About this report.** When and where it ran, the seal status, its integrity in one word (unsigned or keyed), eval-mode notes and the audit record. The footer names `SA_READINESS_SEAL_KEY` for signed reports when the seal is unkeyed.

## Part 1 rules (enforced by `seal`)

- The headline is at most 40 words. It names the component that sets the level and what already works elsewhere. It never pairs a level change with an outcome change in the same sentence.
- At most three gaps, each at most 22 words, each about what holds a component's standard level.
- No code formatting, check IDs, evidence IDs or emoji. Status is a word, not a symbol.
- No banned jargon: "first-push", "oracle", "replay", "bootstrap", "canonical", "mutant", "mutation", "seal", "trajectory", "CI parity".
- A level name ("Bootable", "Verifiable") appears only with its number, as in "Level 1, bootable".
- Narrated text may contain only numbers the audit computed.

## Writing a narration

Narration is optional. The default wording passes the rules. When you narrate, aim for something a director reads in ten seconds:

- Good: "Agents can't pass the tests in api from a clean checkout, and 56% of recent changes land there. shared is already at Level 2."
- Bad: "Bootstrap replay failed for api; oracle coverage is 0/5 in worker." That uses jargon, names checks and gives the reader no message.

The headline says what holds the repo level and where. It doesn't list everything that's wrong; part 5 does that.

## Outcome honesty

- Every rate shows its n and its window. Below 5, the report shows counts only.
- Agent PRs always sit next to other PRs from the same window. A later report adds the previous window; it doesn't replace the comparison.
- A closed step's observed value comes from its own watch metric and scope, in the window after it closed. When several steps closed in one audit, each keeps its own value, and the report says they share the window, so the change can't be credited to one of them. A repo-wide number is never credited to one step.
- The trend caveat sits next to the numbers: a trend, not attribution. Model updates or a different mix of tasks could account for part of a change.
- A PR that touches several components counts in each, and the component table says its rows can add up to more than the total.
- From rubric 2026-12-beta the table has a "Reverted within 14 days" row for agent and other PRs. The note under it says how reverts were found and that a revert squashed without its "This reverts commit" line isn't seen, so the numbers are detected reverts. It also says how many agent PRs merged too recently to have had the full 14 days, names each reverted agent PR and what reverted it, and says nothing gates on the row yet. When no PR record says whether it was reverted (an older recorded PR file, or a failed search), the row reads "not measured" with the reason; it never reads 0%.

## The header

- "Scripts match the vX manifest bundled with this copy": the scripts that ran the audit match the release manifest shipped with them. `verify-seal --release-repo` checks the published release. "Seal not verified" means they don't, or no release manifest shipped with the copy.
- "The seal is keyed": the audit was sealed with `SA_READINESS_SEAL_KEY`, an HMAC key kept as a CI secret, and `verify-seal` needs the same key. Where the key is set, `verify-seal` refuses an unkeyed seal. "An unkeyed digest" catches edits, but anyone with the scripts could reseal an edited audit.
- "Eval run with a pinned seed": the planted-fault seed came from `SA_READINESS_EVAL_SEED`. `readiness verify-seal` won't treat it as a production result.
- "Outcomes come from a recorded PR file": the outcome numbers were read from `--outcomes-input`, not from GitHub. Anyone can write such a file, so `verify-seal` won't treat the audit as a production result either.

## Planted faults

Where each fault was planted stays outside the repository until the seal: the draft audit holds only each fault's result and a digest of the seed, and `status` and the replay log give counts. The sealed audit and part 5 then name each missed fault's operator, file and line, so the tests can be fixed.
