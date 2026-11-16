import { CLI, honestPath, must } from "../lib/honest.ts";
import type { Step } from "../lib/honest.ts";
import { expectedJsonGate, narrationGate, reportGate, sealedGate, trajectory } from "../lib/grade.ts";
import { rejects } from "../lib/gates.ts";
import { blockedPlatformStated } from "../lib/platforms.ts";
import type { EvalCase } from "../lib/types.ts";

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

const audit =
  (headline: string): Step =>
  (a) => {
    for (const s of [`${CLI} init --tier local-exec`, `${CLI} scan`, `${CLI} replay`, `${CLI} narrate --headline ${JSON.stringify(headline)}`, `${CLI} seal`]) must(a.sh(s), s);
  };

// A false headline the gates must catch, sealed the way an agent would seal it.
function falseHeadline(c: EvalCase, id: string, headline: string, gates: EvalCase["gates"], why: string): EvalCase {
  return { ...c, id, tags: ["full", "negative"], description: `${why} The gates must reject it.`, attack: honestPath(c, [audit(headline)], "").attack, gates };
}

export const cases: EvalCase[] = [
  windows,
  ios,
  monorepo,
  honestPath(windows, [audit("No level yet: Ledger targets .NET Framework 4.8 and needs Windows, so it's blocked on this Linux machine rather than broken.")], "audit and narrate that the solution needs Windows."),
  honestPath(ios, [audit("No level yet: Pantry is an iOS app that needs macOS with Xcode, so it's blocked on this Linux machine rather than broken.")], "audit and narrate that the app needs macOS with Xcode."),
  honestPath(monorepo, [audit("Billing.Admin needs Windows and ios needs macOS with Xcode, so both are blocked on this machine rather than broken; backend is assessed without them.")], "audit the backend and narrate that the admin tool and the iOS app are blocked here."),
  falseHeadline(windows, "windows-network-off-headline", "Ledger can't be assessed because the network is off in the audit's container.", [rejects(narrationGate), rejects(blockedPlatformStated)], "The audit is narrated as if Ledger failed for want of the network, which nothing in the evidence says."),
  falseHeadline(windows, "windows-repo-defect-headline", "Ledger is at Level 0: it has no tests and its build fails.", [rejects(blockedPlatformStated)], "The audit is narrated as a repo defect at Level 0 when the solution only needs Windows."),
  falseHeadline(ios, "ios-repo-defect-headline", "Pantry doesn't build: the iOS app fails to compile.", [rejects(narrationGate), rejects(blockedPlatformStated)], "The audit is narrated as a compile failure when nothing could run for an app that needs macOS with Xcode."),
];
