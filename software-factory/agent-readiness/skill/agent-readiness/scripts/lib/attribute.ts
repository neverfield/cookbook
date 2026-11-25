import { diagnose } from "./diagnose.ts";
import type { Rubric } from "./rubric.ts";
import type { Attribution, CommandKind, Diagnosis, Evidence, Where } from "./types.ts";

// Whose failure a failed step is. A failure counts against the repo only when an experiment showed it,
// or when the step ran in an environment whose self-check passed and failed on its own terms. A
// failure the audit's own choices could explain is undetermined, never the repo's by default.

export function attributes(rubric: Rubric): boolean {
  return rubric.attribution?.level0 === "attributed";
}

// The tools that run tests. Missing one means the install left it out, which is the audit's choice of
// install as much as the repo's.
const TEST_RUNNERS = new Set(["pytest", "tox", "nox", "unittest", "nose", "nose2", "vitest", "jest", "mocha", "ava", "tap", "uvu", "jasmine", "karma", "phpunit", "pest", "rspec", "minitest"]);

function runnerOf(d: Diagnosis): string | null {
  if (d.cause !== "missing_module" && d.cause !== "missing_tool") return null;
  const name = d.detail.replace(/^module /, "").replace(/ is (?:missing|not installed)$/, "").split(/[/.]/)[0];
  return TEST_RUNNERS.has(name) ? name : null;
}

export interface AttributionInput {
  result: Evidence["result"];
  kind?: CommandKind;
  where: Where;
  blocked?: string;
  diagnosis?: Diagnosis;
  timedOut?: boolean;
  summary: string;
  outputTail?: string;
}

// Who picked the image: "repo" when the repo declared it. Unknown counts as the audit's choice.
export type ImageSource = "audit" | "override" | "repo" | null | undefined;

// The verdict for a failure no experiment has decided. null for a step that didn't fail.
export function attribute(ev: AttributionInput, imageSource?: ImageSource): Attribution | null {
  if (ev.result !== "fail") return null;
  if (ev.blocked) return { verdict: "environment", basis: "known_cause", detail: ev.blocked };
  const d = ev.diagnosis ?? diagnose(`${ev.summary}\n${ev.outputTail ?? ""}`, Boolean(ev.timedOut), ev.kind ?? "test");
  // A memory cap or a full disk is the machine's or the audit's, whatever image ran.
  if (d.cause === "resource") return { verdict: "undetermined", basis: "known_cause", detail: `${d.detail}, a limit of this machine or the audit's container rather than of the repo` };
  const auditsImage = ev.where !== "container" || imageSource !== "repo";
  const runner = ev.kind === "test" ? runnerOf(d) : null;
  if (runner) return { verdict: "undetermined", basis: "known_cause", detail: `the test runner ${runner} wasn't there to run the tests, so the audit's install may have left it out` };
  if (d.cause === "missing_library") {
    return auditsImage ? { verdict: "undetermined", basis: "known_cause", detail: `${d.detail} from the image the audit picked` } : { verdict: "repo", basis: "known_cause", detail: `${d.detail} from the repo's declared image` };
  }
  if (ev.kind === "install" && d.cause === "unknown" && !d.fromTool && auditsImage) {
    return { verdict: "undetermined", basis: "known_cause", detail: `the install failed in an image the audit picked, and its output doesn't say why (${d.detail})` };
  }
  if (ev.kind === "test" && d.cause === "network") return { verdict: "undetermined", basis: "known_cause", detail: `${d.detail}; a run with the network on would settle whose failure it is` };
  const replayed = ev.where === "container" || ev.where === "disposable_vm";
  return { verdict: "repo", basis: replayed ? "canary" : "known_cause", detail: d.detail };
}

// The attribution a scored failure carries: its own, or one worked out from what it recorded.
export function attributionOf(ev: Evidence): Attribution | null {
  return ev.attribution ?? attribute(ev);
}

// After a rerun with the network on: the failure was the cut network's when the rerun passed, and the
// repo's (or whatever the first verdict said) when it failed again for its own reasons.
export function networkVerdict(first: Attribution | null, rerunPassed: boolean, rerunDetail: string): Attribution {
  if (rerunPassed) return { verdict: "environment", basis: "experiment", changed: "network", detail: "the tests passed when run again with the network on, so they need the network rather than failing on their own" };
  if (first && first.verdict !== "repo" && !(first.verdict === "undetermined" && /network/.test(first.detail))) return first;
  return { verdict: "repo", basis: "experiment", changed: "network", detail: `the tests failed again with the network on (${rerunDetail})` };
}

// Whether a failed test run is worth one rerun with the network on: it ran with the network cut, and
// nothing already explains it as the audit's install or image.
export function rerunsOnline(first: Attribution | null): boolean {
  if (!first) return false;
  return first.verdict === "repo" || (first.verdict === "undetermined" && /network/.test(first.detail));
}
