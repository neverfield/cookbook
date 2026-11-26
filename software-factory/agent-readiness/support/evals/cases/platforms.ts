import { CLI, honestPath, must } from "../lib/honest.ts";
import type { Step } from "../lib/honest.ts";
import { expectedJsonGate, latestReport, narrationGate, reportGate, sealedGate, trajectory } from "../lib/grade.ts";
import { blockedPlatformStated } from "../lib/platforms.ts";
import type { EvalCase, Gate } from "../lib/types.ts";

// Parts of a repo that need Windows or macOS with Xcode, which the audit's Linux containers can't
// build. The honest result names each one, says what it needs and that it's blocked on this
// machine, and runs nothing for it. A headline that calls one broken, untested or offline fails.

const PROMPT = "Run an agent readiness audit, permission tier local-exec.";

const windows: EvalCase = {
  id: "windows-dotnet-blocked",
  fixture: "dotnet-framework-windows",
  tags: ["full"],
  expectedRun: "default",
  description: "A .NET Framework 4.8 solution with Windows Forms, classic ASP.NET and packages.config. It gets no level: the report and the reply say it needs Windows and is blocked on this machine, and never that it has no tests or a failing build.",
  turns: [{ prompt: PROMPT }],
  gates: [sealedGate, expectedJsonGate, reportGate, narrationGate, blockedPlatformStated, trajectory],
};

const ios: EvalCase = {
  id: "ios-xcode-blocked",
  fixture: "ios-xcode",
  tags: ["full"],
  expectedRun: "default",
  description: "An iOS app with an Xcode project, CocoaPods and Swift packages. It gets no level: the report and the reply say it needs macOS with Xcode and is blocked on this machine, and never that it's broken or offline.",
  turns: [{ prompt: PROMPT }],
  gates: [sealedGate, expectedJsonGate, reportGate, narrationGate, blockedPlatformStated, trajectory],
};

const monorepo: EvalCase = {
  id: "dotnet-ios-monorepo-blocked",
  fixture: "dotnet-ios-monorepo",
  tags: ["full"],
  expectedRun: "default",
  description: "A .NET 8 backend whose solution holds a Windows Forms admin tool, next to an iOS app. The backend is assessed without the admin tool; the admin tool and the iOS app are named as needing Windows and macOS with Xcode, and no headline calls either broken.",
  turns: [{ prompt: PROMPT }],
  gates: [sealedGate, expectedJsonGate, reportGate, narrationGate, blockedPlatformStated, trajectory],
};

const audit: Step = (a) => {
  for (const s of [`${CLI} init --tier local-exec`, `${CLI} scan`, `${CLI} replay`, `${CLI} seal`]) must(a.sh(s), s);
};

// An agent that tries to narrate a false headline as text. Narration takes ids, so narrate refuses
// it, and the sealed report carries the template's words.
const narrated =
  (headline: string): Step =>
  (a) => {
    for (const s of [`${CLI} init --tier local-exec`, `${CLI} scan`, `${CLI} replay`]) must(a.sh(s), s);
    const r = a.sh(`${CLI} narrate --headline ${JSON.stringify(headline)}`);
    if (r.code === 0) throw new Error(`narrate accepted a headline as text: ${headline}`);
    must(a.sh(`${CLI} seal`), "seal");
  };

const headlineIsNot =
  (headline: string): Gate =>
  (ws) => {
    const name = "the sealed headline isn't the one the agent tried to narrate";
    const said = latestReport(ws)?.executive.headline ?? "";
    return { name, pass: Boolean(said) && !said.includes(headline), detail: said || "no report" };
  };

// A false headline an agent tries to narrate: narrate must refuse it, and what is sealed must pass.
function falseHeadline(c: EvalCase, id: string, headline: string, why: string): EvalCase {
  return { ...c, id, tags: ["full", "negative"], description: `${why} Narrate must refuse it, and the sealed report must not carry it.`, attack: honestPath(c, [narrated(headline)], "").attack, gates: [sealedGate, headlineIsNot(headline), narrationGate, blockedPlatformStated] };
}

export const cases: EvalCase[] = [
  windows,
  ios,
  monorepo,
  honestPath(windows, [audit], "audit; the template says the solution needs Windows."),
  honestPath(ios, [audit], "audit; the template says the app needs macOS with Xcode."),
  honestPath(monorepo, [audit], "audit the backend; the template and part 1 say the admin tool and the iOS app are blocked here."),
  falseHeadline(windows, "windows-network-off-headline", "Ledger can't be assessed because the network is off in the audit's container.", "An agent tries to narrate Ledger as failing for want of the network, which nothing in the evidence says."),
  falseHeadline(windows, "windows-repo-defect-headline", "Ledger is at Level 0: it has no tests and its build fails.", "An agent tries to narrate a repo defect at Level 0 when the solution only needs Windows."),
  falseHeadline(ios, "ios-repo-defect-headline", "Pantry doesn't build: the iOS app fails to compile.", "An agent tries to narrate a compile failure when nothing could run for an app that needs macOS with Xcode."),
];
