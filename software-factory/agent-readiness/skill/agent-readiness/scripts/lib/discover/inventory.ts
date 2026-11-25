import { basename, dirname } from "node:path";
import { manifestRules } from "../languages/index.ts";

// Every folder that holds a manifest, by every language's manifest rule, including folders the
// scan doesn't treat as projects (marked with the folder name that skips them). Placement then has
// to account for each one: a component, a member of one, a satellite or excluded, never dropped.

export interface InventoryEntry {
  dir: string;
  manifest: string;
  // The folder name that keeps discovery out of it, such as node_modules or fixtures.
  skippedBy?: string;
}

// Vendored, generated and test-data folders: what's under them is never a project of the repo.
export const SKIP_SEGMENT = /^(\..+|node_modules|fixtures?|__fixtures__|testdata|vendor|dist|build|bin|obj|target|Pods|Carthage|DerivedData)$/;
// Build output folders. A committed one that carries its own lockfile is a project after all, such as
// a services/build package.
export const OUTPUT_SEGMENT = /^(dist|build|bin|obj|target)$/;
const XCODE_BUNDLE = /\.(xcodeproj|xcworkspace)$/;
const XCODE_MANIFEST: Record<string, string> = { xcodeproj: "project.pbxproj", xcworkspace: "contents.xcworkspacedata" };
const OTHER = manifestRules();

export function skipSegment(dir: string, lockfileHere: boolean): string | undefined {
  if (dir === ".") return undefined;
  const parts = dir.split("/");
  const hit = parts.find((s) => SKIP_SEGMENT.test(s));
  if (!hit) return undefined;
  // Only the output folder that is the package itself, with its lockfile, is let through.
  if (lockfileHere && OUTPUT_SEGMENT.test(hit) && parts.filter((s) => SKIP_SEGMENT.test(s)).length === 1 && parts.indexOf(hit) === parts.length - 1) return undefined;
  return hit;
}

// The folders and file names of a listing, an Xcode project or workspace counted as one name in the
// folder that holds it.
export function namesByDir(files: string[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const segments = f.split("/");
    const bundle = segments.findIndex((s) => XCODE_BUNDLE.test(s));
    const dir = bundle >= 0 ? segments.slice(0, bundle).join("/") || "." : dirname(f);
    const name = bundle >= 0 ? segments[bundle] : basename(f);
    const names = byDir.get(dir) ?? [];
    if (!names.includes(name)) byDir.set(dir, [...names, name]);
  }
  return byDir;
}

export function pythonManifest(names: string[]): string | null {
  if (names.includes("pyproject.toml")) return "pyproject.toml";
  if (names.includes("setup.py")) return "setup.py";
  if (names.includes("requirements.txt") && names.some((n) => n.endsWith(".py"))) return "requirements.txt";
  return null;
}

export function inventory(files: string[], lockfiles: string[]): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const [dir, names] of namesByDir(files)) {
    const rel = (n: string) => (dir === "." ? n : `${dir}/${n}`);
    let manifest: string | null = null;
    if (names.includes("package.json")) manifest = rel("package.json");
    else if (pythonManifest(names)) manifest = rel(pythonManifest(names)!);
    else {
      const rule = OTHER.find((u) => names.some((n) => u.match.test(n)));
      if (rule) {
        const picked = names.filter((n) => rule.match.test(n)).sort()[0];
        const bundle = picked.match(XCODE_BUNDLE)?.[1];
        manifest = rel(bundle ? `${picked}/${XCODE_MANIFEST[bundle]}` : picked);
      }
    }
    if (!manifest) continue;
    const skippedBy = skipSegment(dir, lockfiles.some((l) => names.includes(l)));
    out.push({ dir, manifest, ...(skippedBy ? { skippedBy } : {}) });
  }
  return out.sort((a, b) => (a.dir === "." ? -1 : b.dir === "." ? 1 : a.dir.localeCompare(b.dir)));
}
