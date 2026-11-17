import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { PREVIEW } from "../skill/agent-readiness/scripts/lib/preview.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { validateAgainst } from "../skill/agent-readiness/scripts/lib/schema.ts";
import { notSupportedReason } from "../skill/agent-readiness/scripts/lib/support.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const COOKBOOK_README = join(ROOT, "..", "..", "README.md");
const CLI = join(ROOT, "skill/agent-readiness/scripts/readiness.ts");
const read = (p: string) => readFileSync(p, "utf8");

// Every place a reader meets the skill in prose; each quotes PREVIEW as a block note until 1.0.
const DOCS = [
  "README.md",
  "skill/agent-readiness/SKILL.md",
  "skill/agent-readiness/references/checks.md",
  "skill/agent-readiness/references/levels.md",
  "skill/agent-readiness/references/report.md",
  "skill/agent-readiness/references/supported.md",
  "support/README.md",
].map((f) => join(ROOT, f)).concat(COOKBOOK_README);

const tracked = () => execFileSync("git", ["ls-files", "skill", "support", "README.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => /\.(ts|md|json|ya?ml)$/.test(f) && !f.startsWith("support/fixtures/") && !f.startsWith("support/trials/recordings/"));

describe("the Preview label", () => {
  test("is on exactly while the release is before 1.0, and names the release's minor version", () => {
    const version = JSON.parse(read(join(ROOT, "skill/agent-readiness/RELEASE.json"))).version as string;
    const [major, minor] = version.split(".").map(Number);
    assert.equal(PREVIEW !== null, major < 1, `RELEASE.json is ${version}; PREVIEW must be ${major < 1 ? "set" : "null"} (scripts/lib/preview.ts)`);
    if (PREVIEW) assert.ok(PREVIEW.includes(` ${major}.${minor} `), PREVIEW);
  });

  test("every doc a reader meets quotes it, and none keeps it once it is off", () => {
    for (const f of DOCS) {
      const text = read(f);
      if (PREVIEW) assert.ok(text.includes(`\n> ${PREVIEW}\n`), `${f} lacks the Preview note`);
      else assert.doesNotMatch(text, /is pre-1\.0/, `${f} still has the Preview note`);
    }
  });

  test("every label is the constant's text, and no script spells it out", () => {
    const stray: string[] = [];
    for (const f of tracked()) {
      const text = read(join(ROOT, f));
      if (f.endsWith(".ts") && f !== "skill/agent-readiness/scripts/lib/preview.ts" && /is pre-1\.0/.test(text)) stray.push(`${f}: spells the label out instead of importing PREVIEW`);
      for (const line of text.split("\n")) if (/\bPreview:/.test(line) && (!PREVIEW || !line.includes(PREVIEW))) stray.push(`${f}: ${line.trim()}`);
    }
    assert.deepEqual(stray, []);
  });

  test("the report carries it at the top of report.json, report.md and report.html, and levels don't move", () => {
    const r = reportFor(makeAudit({ components: [{ id: "api", share: 1 }] }));
    assert.deepEqual(validateAgainst("report", r), []);
    assert.equal(r.preview, PREVIEW ?? undefined);
    const md = renderMarkdown(r, loadRubric("2026-11-beta"));
    const html = renderHtml(r);
    if (PREVIEW) {
      assert.ok(md.startsWith(`# Agent readiness: ${r.repo}\n\n> ${PREVIEW}\n`), md.slice(0, 200));
      assert.match(html, new RegExp(`</header><p class="note">${PREVIEW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
    } else {
      assert.doesNotMatch(md, /Preview/);
      assert.doesNotMatch(html, /Preview/);
    }
    const { preview: _, ...unlabelled } = r;
    assert.equal(renderMarkdown(unlabelled, loadRubric("2026-11-beta")), PREVIEW ? md.replace(`> ${PREVIEW}\n\n`, "") : md);
  });

  test("sits above an all-blocked platform headline without changing it", () => {
    const audit = makeAudit({ components: [{ id: "Ledger", share: 1, assessed: false }] });
    for (const c of audit.profile!.components) {
      c.stack = "dotnet-windows";
      c.notAssessedReason = notSupportedReason(c.stack);
    }
    const r = reportFor(audit);
    assert.equal(r.executive.headline, "No component could be assessed, so this audit can't give a level yet: Ledger needs Windows to build; it's blocked on this machine, not broken.");
    assert.equal(r.preview, PREVIEW ?? undefined);
    const md = renderMarkdown(r, loadRubric("2026-11-beta"));
    if (PREVIEW) assert.ok(md.startsWith(`# Agent readiness: ${r.repo}\n\n> ${PREVIEW}\n`), md.slice(0, 200));
    assert.ok(md.includes(`**${r.executive.headline}**`));
    if (PREVIEW) assert.ok(renderHtml(r).includes(`</header><p class="note">${PREVIEW}</p>`));
  });

  test("the CLI prints it with help and version", () => {
    for (const args of [["--help"], ["version"]]) {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: ROOT, encoding: "utf8" });
      if (PREVIEW) assert.ok(out.includes(PREVIEW), `${args.join(" ")}: ${out.slice(0, 200)}`);
      else assert.doesNotMatch(out, /Preview/);
    }
  });
});
