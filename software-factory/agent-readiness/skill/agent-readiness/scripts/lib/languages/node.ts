import { join } from "node:path";
import { exists, readJson, readText } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: Record<string, string>;
  packageManager?: string;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  volta?: Record<string, string>;
}

export function readPackageJson(dir: string): PackageJson | null {
  const p = join(dir, "package.json");
  if (!exists(p)) return null;
  try {
    return readJson<PackageJson>(p);
  } catch {
    return null;
  }
}

// The folders whose package.json or .yarnrc.yml decide a component's Yarn: its own, then the root's.
function yarnDirs(dir: string): string[] {
  return dir === "." ? ["."] : [dir, "."];
}

export function yarnPath(tree: string, dir: string): string | null {
  for (const d of yarnDirs(dir)) {
    const f = join(tree, d, ".yarnrc.yml");
    const path = exists(f) ? readText(f).match(/^yarnPath:\s*["']?([^"'\s#]+)/m)?.[1] : undefined;
    if (path) return d === "." ? ".yarnrc.yml" : `${d}/.yarnrc.yml`;
  }
  return null;
}

// Yarn 2 and later: a packageManager pin of yarn@2 or above, a .yarnrc.yml, or a Berry lockfile.
export function yarnBerry(tree: string, dir: string): boolean {
  for (const d of yarnDirs(dir)) {
    const major = Number(readPackageJson(join(tree, d))?.packageManager?.match(/^yarn@(\d+)/)?.[1] ?? 0);
    if (major >= 2 || exists(join(tree, d, ".yarnrc.yml"))) return true;
    if (exists(join(tree, d, "yarn.lock")) && /^__metadata:/m.test(readText(join(tree, d, "yarn.lock")))) return true;
  }
  return false;
}

// Corepack runs the Yarn a packageManager pin names, and Yarn 1 hands over to a yarnPath release.
// With neither, Corepack would run Yarn 1 against a Berry project.
export function yarnPinned(tree: string, dir: string): boolean {
  return yarnDirs(dir).some((d) => /^yarn@/.test(readPackageJson(join(tree, d))?.packageManager ?? "")) || yarnPath(tree, dir) !== null;
}

export const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

const NO_LOCKFILE = "no lockfile is committed";

type Semver = [number, number, number];
const semver = (v: string): Semver | null => {
  const m = v.trim().match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  return m ? [Number(m[1]), Number(m[2]) || 0, Number(m[3]) || 0] : null;
};
const below = (a: Semver, b: Semver) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]);

// Whether `version` is older than every alternative of an engines range allows: `>=22.19.0`,
// `^20.19.0 || >=22.12.0`. Only a lower bound counts, so a stale upper bound on an old package
// never reads as a gap.
export function olderThanRange(version: string, range: string): boolean {
  const have = semver(version);
  if (!have) return false;
  const alternatives = range.split("||").map((either) => {
    const alt = either.split(" - ")[0];
    const floors = [...alt.matchAll(/(>=|>|\^|~|=)?\s*v?(\d+(?:\.(?:\d+|x|\*)){0,2})/g)]
      .filter((m) => !/[<]\s*$/.test(alt.slice(0, m.index)))
      .flatMap((m) => {
        const v = semver(m[2]);
        return v ? [{ v, strict: m[1] === ">" }] : [];
      });
    return floors.length ? floors.reduce((a, b) => (below(a.v, b.v) ? b : a)) : null;
  });
  if (alternatives.some((a) => a === null)) return false;
  return alternatives.every((a) => below(have, a!.v) || (a!.strict && !below(a!.v, have)));
}

// The first locked dependency whose engines.node the given Node is too old for, from the nearest
// pnpm-lock.yaml or package-lock.json at or above `dir`.
export function lockedEngineGap(root: string, dir: string, version: string): { pkg: string; range: string } | null {
  const parts = dir === "." ? [] : dir.split("/");
  for (let i = parts.length; i >= 0; i--) {
    const at = join(root, ...parts.slice(0, i));
    const pnpm = join(at, "pnpm-lock.yaml");
    if (exists(pnpm)) {
      let pkg = "";
      for (const line of readText(pnpm).split("\n")) {
        const head = line.match(/^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^:'(\s]+)/);
        if (head) pkg = `${head[1]} ${head[2]}`;
        const range = line.match(/^ {4}engines: \{[^}]*\bnode: '?([^',}]+)'?/)?.[1];
        if (pkg && range && olderThanRange(version, range)) return { pkg, range };
      }
      return null;
    }
    const npm = join(at, "package-lock.json");
    if (exists(npm)) {
      try {
        const lock = readJson<{ packages?: Record<string, { version?: string; engines?: unknown }> }>(npm);
        for (const [path, p] of Object.entries(lock.packages ?? {})) {
          const range = typeof p.engines === "object" && p.engines !== null && !Array.isArray(p.engines) ? (p.engines as Record<string, unknown>).node : undefined;
          if (path && typeof range === "string" && olderThanRange(version, range)) return { pkg: `${path.replace(/^.*node_modules\//, "")} ${p.version ?? ""}`.trim(), range };
        }
      } catch {
        return null;
      }
      return null;
    }
  }
  return null;
}

function lockedBy(names: string[]) {
  return (tree: string, path: string) => (names.some((n) => exists(join(tree, path, n))) ? null : NO_LOCKFILE);
}

const npm: Ecosystem = {
  id: "npm",
  label: "npm",
  lockfiles: ["package-lock.json"],
  rule: "`npm ci` from a committed `package-lock.json`",
  install: (tree, path, { ignoreScripts }) => {
    const flag = ignoreScripts ? " --ignore-scripts" : "";
    return exists(join(tree, path, "package-lock.json"))
      ? { command: `npm ci${flag}`, reason: "frozen install from package-lock.json", frozen: true }
      : { command: `npm install${flag}`, reason: "no lockfile, so the install can't be frozen", frozen: false };
  },
  unpinned: lockedBy(["package-lock.json"]),
};

const pnpm: Ecosystem = {
  id: "pnpm",
  label: "pnpm",
  lockfiles: ["pnpm-lock.yaml"],
  rule: "`pnpm install --frozen-lockfile` from a committed `pnpm-lock.yaml`, with the pinned pnpm",
  install: (_tree, _path, { ignoreScripts }) => ({ command: `corepack pnpm install --frozen-lockfile${ignoreScripts ? " --ignore-scripts" : ""}`, reason: "frozen install from pnpm-lock.yaml", frozen: true }),
  unpinned: lockedBy(["pnpm-lock.yaml"]),
};

const yarn: Ecosystem = {
  id: "yarn",
  label: "Yarn",
  lockfiles: ["yarn.lock"],
  rule: "`yarn install --frozen-lockfile` (Yarn 1) or `--immutable` (Yarn 2 or later) from a committed `yarn.lock`, with the pinned Yarn",
  install: (tree, path, { ignoreScripts }) => {
    // Berry has no --ignore-scripts; --mode=skip-build skips the same build scripts.
    if (yarnBerry(tree, path)) return { command: `corepack yarn install --immutable${ignoreScripts ? " --mode=skip-build" : ""}`, reason: "immutable install from yarn.lock (Yarn 2 or later)", frozen: true };
    return { command: `corepack yarn install --frozen-lockfile${ignoreScripts ? " --ignore-scripts" : ""}`, reason: "frozen install from yarn.lock", frozen: true };
  },
  unpinned: lockedBy(["yarn.lock"]),
};

const bun: Ecosystem = {
  id: "bun",
  label: "Bun",
  lockfiles: ["bun.lock", "bun.lockb"],
  rule: "`bun install --frozen-lockfile` from a committed `bun.lock` or `bun.lockb`, with the pinned Bun",
  install: (tree, path, { ignoreScripts }) => {
    const flag = ignoreScripts ? " --ignore-scripts" : "";
    const dir = join(tree, path);
    return exists(join(dir, "bun.lock")) || exists(join(dir, "bun.lockb"))
      ? { command: `bun install --frozen-lockfile${flag}`, reason: `frozen install from ${exists(join(dir, "bun.lock")) ? "bun.lock" : "bun.lockb"}`, frozen: true }
      : { command: `bun install${flag}`, reason: "no lockfile, so the install can't be frozen", frozen: false };
  },
  unpinned: lockedBy(["bun.lock", "bun.lockb"]),
};

export const node: LanguageDef = {
  id: "node",
  label: "Node",
  codes: ["ts", "js"],
  builtIn: true,
  stacks: [
    { id: "npm", label: "Node with npm", kind: "stack", tier: "supported", proof: ["fixtures/healthy-node", "sindresorhus/slugify@3b17b2e"] },
    { id: "npm-workspaces", label: "npm workspaces", kind: "stack", tier: "supported", proof: ["fixtures/monorepo-mixed", "fixtures/sampled-scope"] },
    { id: "pnpm", label: "Node with pnpm", kind: "stack", tier: "supported", proof: ["fixtures/standalone-nested-mixed", "t3-oss/create-t3-turbo@8f945b7"] },
    { id: "yarn", label: "Node with Yarn 1", kind: "stack", tier: "supported", proof: ["fixtures/yarn-classic"] },
    { id: "bun", label: "Bun", kind: "stack", tier: "supported", reason: "the audit adds the pinned Bun to its Node image, from the npm registry", proof: ["fixtures/bun-lock", "elysiajs/elysia@e037eca"] },
    { id: "yarn-berry", label: "Yarn 2 or later", kind: "stack", tier: "supported", reason: "Corepack runs the pinned Yarn, or Yarn hands over to the yarnPath release; the install is immutable", proof: ["fixtures/yarn-berry"] },
    { id: "yarn-berry-unpinned", label: "Yarn 2 or later with no version pin", kind: "stack", tier: "not_yet", reason: "nothing says which Yarn to run: add packageManager to package.json or yarnPath to .yarnrc.yml", proof: ["tests/toolchains.test.ts"] },
  ],
  detect: { lockfiles: NODE_LOCKFILES },
  ecosystems: [npm, pnpm, yarn, bun],
};
