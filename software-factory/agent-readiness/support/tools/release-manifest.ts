import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillDigest } from "../../skill/agent-readiness/scripts/lib/workspace.ts";
import { readJson, writeJson } from "../../skill/agent-readiness/scripts/lib/util.ts";
import { SKILL } from "./fixture.ts";

// The README Quickstart clones the release this manifest names, so a reader never copies a ref the
// manifest doesn't describe. Null when they agree.
export function quickstartMismatch(readme: string, tag: string): string | null {
  const clone = readme.split("\n").find((l) => /^git clone .*cursor\/cookbook/.test(l));
  if (!clone) return "README.md's Quickstart has no git clone of cursor/cookbook";
  if (!clone.includes(`--branch ${tag}`)) return `README.md's Quickstart clones "${clone}", not --branch ${tag}`;
  if (/No release tag exists yet/.test(readme)) return `README.md says no release tag exists, but the manifest names ${tag}`;
  return null;
}

function main(): void {
  const pkg = readJson<{ version?: string }>(join(SKILL, "..", "..", "package.json"));
  const version = process.argv[2] ?? pkg.version ?? "0.1.0";
  const manifest = { version, tag: `agent-readiness-v${version}`, scriptsDigest: skillDigest() };
  const mismatch = quickstartMismatch(readFileSync(join(SKILL, "..", "..", "README.md"), "utf8"), manifest.tag);
  if (mismatch) {
    process.stderr.write(`RELEASE.json not written: ${mismatch}. Point the Quickstart at the release first.\n`);
    process.exit(1);
  }
  writeJson(join(SKILL, "RELEASE.json"), manifest);
  process.stdout.write(`RELEASE.json: ${manifest.tag} ${manifest.scriptsDigest}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
