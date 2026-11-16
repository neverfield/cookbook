import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { exists, listFiles, readText } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Java, Kotlin and .NET group. Recognized and listed with its share of changes; not
// scored until this file has `replay` hooks and the stack moves to the supported tier.

const PROJECT = /\.(csproj|fsproj|vbproj)$/;
const OUTPUT = /(^|\/)(bin|obj)\//;

// Projects that reference packages, each with whether a packages.lock.json sits next to it.
function projects(tree: string, path: string): { file: string; locked: boolean }[] {
  return listFiles(join(tree, path))
    .filter((f) => PROJECT.test(f) && !OUTPUT.test(f) && /<PackageReference\b/.test(readText(join(tree, path, f))))
    .map((f) => ({ file: f, locked: exists(join(tree, path, dirname(f), "packages.lock.json")) }));
}

const nuget: Ecosystem = {
  id: "nuget",
  label: "NuGet",
  lockfiles: ["packages.lock.json"],
  rule: "`dotnet restore --locked-mode` with a committed `packages.lock.json` next to every project that references packages",
  install: (tree, path) => {
    const open = projects(tree, path).filter((p) => !p.locked);
    return open.length === 0
      ? { command: "dotnet restore --locked-mode", reason: "locked restore from each project's packages.lock.json", frozen: true }
      : { command: "dotnet restore", reason: "some projects have no packages.lock.json, so the restore can't be frozen", frozen: false };
  },
  unpinned: (tree, path) => {
    const all = projects(tree, path);
    const open = all.filter((p) => !p.locked);
    return open.length ? `${open.length} of ${all.length} projects that reference packages have no packages.lock.json` : null;
  },
};

// Only the folder's own files: a solution next to its projects' folders.
function soleProject(tree: string, manifest: string): boolean {
  const ext = manifest.match(/\.\w+$/)![0];
  return readdirSync(join(tree, dirname(manifest))).filter((n) => n.endsWith(ext)).length === 1;
}

export const dotnet: LanguageDef = {
  id: "dotnet",
  label: ".NET",
  codes: ["csharp"],
  stacks: [{ id: "dotnet", label: ".NET", kind: "stack", tier: "not_assessed", files: /\.(cs|fs|vb|csproj|fsproj|vbproj|sln|razor)$/, proof: ["fixtures/nested-apps-dotnet", "fixtures/standalone-nested-mixed", "ShareX/ShareX@12d6342"] }],
  detect: {
    // A solution file comes first so it groups the projects under it into one component.
    manifests: [
      { match: /\.sln$/, stack: "dotnet", rank: 10 },
      { match: PROJECT, stack: "dotnet", rank: 11 },
    ],
    sources: [{ ext: /\.(cs|fs)$/, stack: "dotnet", rank: 50 }],
    lockfiles: ["packages.lock.json"],
    // Several solutions in one folder name the project only when one matches the repo, so ShareX
    // isn't named after ShareX.ImageEditor.sln.
    projectName: (tree, manifest, _text, repoName) => {
      if (!/\.(sln|csproj|fsproj|vbproj)$/.test(manifest)) return undefined;
      const stem = manifest.split("/").pop()!.replace(/\.\w+$/, "");
      return soleProject(tree, manifest) || stem.toLowerCase() === repoName.toLowerCase() ? stem : undefined;
    },
  },
  ecosystems: [nuget],
};
