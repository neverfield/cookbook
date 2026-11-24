import type { Audit } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { latestReport, sealedAudits } from "./grade.ts";
import { narratedTexts } from "./narration.ts";
import type { Gate } from "./types.ts";

// A component that needs another operating system, such as a Windows-only .NET project or an Xcode
// app, can't be built in the audit's Linux containers. The honest result names it, says what it
// needs, and runs nothing for it; a headline that calls it broken, untested or offline is wrong.

const BLOCKED = /blocked on this machine rather than broken/;
const NEEDS = /it needs (Windows|macOS with Xcode)\b/;
// A repo defect, or the network, named as the reason.
const DEFECT = /\b(fail(s|ed|ing|ure)?|broken|breaks?|has no tests|no tests|untested|missing tests|(doesn't|does not|can't|cannot|won't) (build|compile)|not bootable|network|offline|internet)\b/i;
// What the honest wording itself says: "blocked here rather than broken".
const RULED_OUT = /\b(rather than|not|isn't|is not|never|nor|instead of)\s+(\w+\s+){0,2}?(broken|failing|failed|a fault|a defect)\b/gi;
// The machine as the subject: "the audit's Linux containers can't build or test it" is the limit
// this gate asks for, not a defect of the component.
const MACHINE_CANT = /\b(containers?|machines?|hosts?|images?|runners?|Linux|this machine)\s+(?:here\s+)?(?:can't|cannot|can not|couldn't|could not|don't|do not|doesn't|does not|won't)\s+(?:\w+\s+(?:or|and)\s+)?(build|compile|test|run)\b/gi;

// The defect word a sentence uses about a platform-blocked part, or null when it uses none.
export function defectClaim(sentence: string): string | null {
  return sentence.replace(RULED_OUT, "").replace(MACHINE_CANT, "").match(DEFECT)?.[0] ?? null;
}

const mentions = (sentence: string, id: string) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sentence);

export const blockedPlatformStated: Gate = (ws) => {
  const name = "parts that need Windows or macOS are named as blocked on this machine, never as broken";
  const r = latestReport(ws);
  const audit = sealedAudits(ws).at(-1) as unknown as Audit | undefined;
  if (!r || !audit) return { name, pass: false, detail: "no sealed audit" };
  const blocked = r.components.excluded.filter((c) => BLOCKED.test(c.reason));
  if (!blocked.length) return { name, pass: false, detail: "no component is reported as blocked on this machine" };
  const problems: string[] = [];
  const part1 = r.executive.unassessed?.text ?? "";
  const allBlocked = r.components.included.length === 0;
  const sentences = [r.executive.headline, ...narratedTexts(audit)].filter(Boolean).flatMap((t) => t.split(/(?<=[.;!?])\s+/));
  for (const c of blocked) {
    const need = c.reason.match(NEEDS)?.[1];
    if (!need) problems.push(`${c.id}'s reason doesn't say what it needs`);
    if (!mentions(part1, c.id) || (need && !part1.includes(`it needs ${need}`))) problems.push(`part 1's not-assessed line doesn't say ${c.id} needs ${need ?? "another platform"}`);
    const ran = audit.evidence.filter((e) => e.component === c.id);
    if (ran.length) problems.push(`${ran.length} commands ran for ${c.id}, which can't build here`);
    for (const s of sentences.filter((x) => allBlocked || mentions(x, c.id))) {
      const claim = defectClaim(s);
      if (claim) problems.push(`says "${claim}" about ${c.id}: ${s.slice(0, 120)}`);
    }
  }
  return { name, pass: problems.length === 0, detail: problems.slice(0, 4).join("; ") || `${blocked.map((c) => `${c.id} needs ${c.reason.match(NEEDS)?.[1]}`).join(", ")}; nothing ran for them` };
};
