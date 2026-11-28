import { dirname, join } from "node:path";
import type { Component, ContractCommand, PackageManager } from "../types.ts";
import { exists, lastNumber, listFiles, readJson, readText, shellQuote } from "../util.ts";
import { quotedLines, sitesForLine } from "./fault-sites.ts";
import { importedFiles, plantable, reachingTests } from "./imports.ts";
import type { ContractContext, Ecosystem, LanguageDef, ToolSetup } from "./language.ts";
import { typecheckProbe } from "./probes.ts";
import { isTestFile } from "./test-paths.ts";

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

// Node majors the audit has a pinned image for (images.ts). Even majors are the LTS lines.
export const NODE_MAJORS = [16, 18, 20, 22, 24, 26];
export const DEFAULT_NODE = 22;

const PLACEHOLDER_TEST = /no test specified/;

const SCRIPT_ALIASES: Record<"build" | "lint" | "typecheck" | "test", string[]> = {
  build: ["build"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "check-types", "tsc"],
  test: ["test"],
};

function runScript(pm: string | null, script: string): string {
  if (pm === "pnpm") return `corepack pnpm run ${script}`;
  if (pm === "yarn") return `corepack yarn run ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

// The root test script when it is a bare vitest or jest run that a path argument narrows.
const ROOT_RUNNER = /^(?:npx\s+|(?:corepack\s+)?(?:pnpm|yarn)\s+(?:exec\s+)?)?(vitest|jest)((?:\s+(?:run|--?[\w-]+(?:=\S+)?))*)\s*$/;

export function rootTestRunner(tree: string): { script: string; runner: string } | null {
  const scripts = readPackageJson(tree)?.scripts ?? {};
  const m = scripts.test?.trim().match(ROOT_RUNNER);
  return m ? { script: "test", runner: m[1] } : null;
}

const TEST_FILE = /(^|\/)(__tests__\/.+|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/;

function hasTestFiles(dir: string): boolean {
  return exists(dir) && listFiles(dir).some((f) => !f.includes("node_modules/") && TEST_FILE.test(f));
}

function scopedRun(pm: string | null, script: string, path: string): string {
  const arg = /^[\w./@-]+$/.test(path) ? path : shellQuote(path);
  return pm === "npm" || !pm ? `npm run ${script} -- ${arg}` : `${runScript(pm, script)} ${arg}`;
}

function nodeImage(tree: string, dirs: string[]): string {
  let major: number | null = null;
  for (const dir of dirs) {
    for (const f of [".nvmrc", ".node-version"]) {
      if (exists(join(tree, dir, f))) major = nodeMajor(readText(join(tree, dir, f)), true);
      if (major) break;
    }
    if (!major && exists(join(tree, dir, "package.json"))) {
      try {
        const engines = (JSON.parse(readText(join(tree, dir, "package.json"))) as { engines?: { node?: string } }).engines?.node ?? "";
        major = engines.trim() ? nodeMajor(engines, false) : null;
      } catch {
        major = null;
      }
    }
    if (major) break;
  }
  // The full image, like a CI runner, has python3, make and g++ for native npm builds.
  return `node:${major ?? DEFAULT_NODE}-bookworm`;
}

const LTS_NAMES: Record<string, number> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

// The Node major to run, always one the audit has an image for. A version file names one line, and
// keeps it when there is an image, else the nearest newer LTS: node:12-bookworm doesn't exist. An
// engines range runs on the default LTS when it allows it, as a CI runner would, so ">=12.20.0"
// gets Node 22 rather than a Node 12 that has no image and couldn't run current tooling.
export function nodeMajor(spec: string, versionFile: boolean): number | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s === "node" || s === "latest" || s === "lts/*" || s === "*" || s === "x") return DEFAULT_NODE;
  const lts = s.match(/^lts\/([a-z]+)/)?.[1];
  const range = s.split("||").map((p) => p.trim()).filter(Boolean).pop() ?? s;
  const lower = lts && LTS_NAMES[lts] ? LTS_NAMES[lts] : Number(range.match(/(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(lower)) return null;
  // "<21" and "<21.0" stop at 20; "<=21" and "<21.4" allow 21.
  const um = range.match(/<(=?)\s*v?(\d+)(?:\.(\d+))?/);
  const upper = !um ? Infinity : um[1] === "=" || Number(um[3] ?? 0) > 0 ? Number(um[2]) : Number(um[2]) - 1;
  const open = !versionFile && !lts && /^>/.test(range) && upper === Infinity;
  const within = NODE_MAJORS.filter((m) => m >= lower && m <= upper);
  const atOrAbove = NODE_MAJORS.filter((m) => m >= lower);
  if (open) return lower <= DEFAULT_NODE ? DEFAULT_NODE : (atOrAbove[0] ?? NODE_MAJORS[NODE_MAJORS.length - 1]);
  const bounded = !versionFile && upper !== Infinity && upper > lower;
  if (bounded && within.length) return within.filter((m) => m <= DEFAULT_NODE).pop() ?? within[0];
  if (NODE_MAJORS.includes(lower)) return lower;
  return atOrAbove[0] ?? NODE_MAJORS[NODE_MAJORS.length - 1];
}

const ciTest = (c: Component, ctx: ContractContext) => ctx.ciTestScript(c.path, c.scripts);

// A component's build, lint, type-check and test scripts. From 2026-12-beta the test script CI runs
// in the component's folder outranks the manifest's test script, when it is a different one. With
// no test script, a Make target that runs the tests, such as `make test` calling a test:unit script:
// the repo's own entry point is the test command.
function nodeCommands(tree: string, c: Component, ctx: ContractContext): ContractCommand[] {
  const out: ContractCommand[] = [];
  const pm = ctx.profile.packageManager;
  const timeout = ctx.timeoutSec;
  for (const kind of ["build", "lint", "typecheck", "test"] as const) {
    const script = SCRIPT_ALIASES[kind].find((s) => c.scripts[s] && !(kind === "test" && PLACEHOLDER_TEST.test(c.scripts[s])));
    const fromCi = kind === "test" && ctx.rubric.attribution ? ciTest(c, ctx) : null;
    if (fromCi && fromCi.script !== script) {
      const via = fromCi.called === fromCi.script ? "" : `, through its ${fromCi.called} script`;
      out.push(ctx.checkOnly({ id: `cmd-${c.id}-test`, kind, component: c.id, cwd: c.path, command: runScript(c.packageManager ?? pm, fromCi.script), source: fromCi.source, reason: `the test script CI runs${via}`, timeoutSec: timeout, tier: "ci", confidence: fromCi.called === fromCi.script ? "declared" : "derived" }, c.scripts, c.packageManager ?? pm));
      continue;
    }
    if (!script) continue;
    const cmd: ContractCommand = { id: `cmd-${c.id}-${kind}`, kind, component: c.id, cwd: c.path, command: runScript(c.packageManager ?? pm, script), source: `${c.manifest} scripts.${script}`, reason: `discovered ${kind} script`, timeoutSec: timeout, tier: "manifest", confidence: "declared" };
    out.push(ctx.checkOnly(cmd, c.scripts, c.packageManager ?? pm));
  }
  if (!out.some((k) => k.kind === "test")) {
    const makefile = c.path === "." ? "Makefile" : `${c.path}/Makefile`;
    const make = ctx.makeTestTarget(exists(join(tree, makefile)) ? readText(join(tree, makefile)) : null);
    if (make) out.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.path, command: `make ${make.target}`, source: `${makefile}:${make.line}`, reason: `the Makefile's ${make.target} target runs the tests`, timeoutSec: timeout, tier: "task_runner", confidence: "derived" });
  }
  return out;
}

// The Corepack release on npm on Nov 27, 2026.
const COREPACK = "corepack@0.36.0";

// Bun in the Node image, at the version the repo pins. Corepack runs the version packageManager
// names, or its own default. With no packageManager, an exact engines pin is the version the repo's
// engine check accepts, so corepack is set to it.
function nodeSetup(tree: string, pms: Map<PackageManager, string>, homeDir: string): ToolSetup[] {
  const out: ToolSetup[] = [];
  const bunDir = pms.get("bun");
  if (bunDir !== undefined) {
    const pkg = readPackageJson(join(tree, bunDir));
    const pin = pkg?.packageManager?.match(/^bun@(\d[\w.+-]*)/)?.[1] ?? pkg?.engines?.bun;
    const spec = `bun@${pin ?? "1"}`;
    out.push({ tool: "bun", spec, install: `npm install -g --silent --no-fund --no-audit ${shellQuote(spec)}` });
  }
  // Node 25 and later ship without Corepack, which runs the pinned pnpm or Yarn, so it's added where
  // the image lacks it.
  if (pms.has("pnpm") || pms.has("yarn")) out.push({ tool: "corepack", spec: COREPACK, install: `npm install -g --silent --no-fund --no-audit ${COREPACK}` });
  for (const pm of ["pnpm", "yarn"] as const) {
    const dir = pms.get(pm);
    if (dir === undefined) continue;
    const pkg = readPackageJson(join(tree, dir));
    const pin = pkg?.packageManager ? null : pkg?.engines?.[pm]?.trim().match(/^=?v?(\d+\.\d+\.\d+)$/)?.[1];
    // Setup runs under its own home; the repo's commands read corepack's default from theirs.
    const home = `COREPACK_HOME=${homeDir}/.cache/node/corepack`;
    if (pin) out.push({ tool: pm, spec: `${pm}@${pin}`, install: `${home} corepack prepare ${shellQuote(`${pm}@${pin}`)} --activate`, present: `test "$(${home} corepack ${pm} --version 2>/dev/null)" = ${pin}` });
  }
  return out;
}

// node --test (tap and spec), bun test, vitest, jest and mocha.
function nodeTestCounts(text: string): { passed: number; failed: number; total: number } | null {
  const num = (re: RegExp) => lastNumber(text, re);
  const nodePass = num(/^\s*[#\u2139] pass (\d+)\s*$/m);
  if (nodePass !== null) {
    const failed = num(/^\s*[#\u2139] fail (\d+)\s*$/m) ?? 0;
    return { passed: nodePass, failed, total: num(/^\s*[#\u2139] tests (\d+)\s*$/m) ?? nodePass + failed };
  }
  const bunRan = num(/^Ran (\d+) tests? across \d+ files?\./m);
  if (bunRan !== null) {
    const failed = num(/^\s*(\d+) fail\s*$/m) ?? 0;
    return { passed: num(/^\s*(\d+) pass\s*$/m) ?? bunRan - failed, failed, total: bunRan };
  }
  const vitest = [...text.matchAll(/Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed[^(\n]*\((\d+)\)/g)].pop();
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0), total: Number(vitest[3]) };
  const jest = [...text.matchAll(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(\d+) passed, (\d+) total/g)].pop();
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0), total: Number(jest[3]) };
  const mochaPass = num(/^\s*(\d+) passing\b/m);
  if (mochaPass !== null) {
    const failed = num(/^\s*(\d+) failing\b/m) ?? 0;
    return { passed: mochaPass, failed, total: mochaPass + failed };
  }
  return null;
}

const nodeCode = (c: Component) => c.language === "ts" || c.language === "js";

const JS_TEST = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/;
const JS_COUNTED = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const isJsTest = (f: string) => isTestFile(f) && JS_TEST.test(f);

export const node: LanguageDef = {
  id: "node",
  label: "Node",
  codes: ["ts", "js"],
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
  checks: {
    weakening: {
      isTest: isTestFile,
      markers: { skip: /\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe|test)\(/, testCase: /\b(it|test)\(\s*['"`]/ },
    },
    lockfiles: {
      diff: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
      secretScanSkips: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"],
      foreign: { npm: "package-lock.json", yarn: "yarn.lock", pnpm: "pnpm-lock.yaml" },
    },
    manifestScripts: {
      manifest: (path) => path.endsWith("package.json"),
      read: (tree, manifest) => readPackageJson(join(tree, dirname(manifest)))?.scripts ?? null,
      installHook: /^(pre|post)?install$|^prepare$|^prepublish$/,
    },
    tool: /^(npm|npx|pnpm|pnpx|yarn|node|bun|bunx|corepack|tsc|vitest|jest)$/,
    // Unlike the fault hooks' rule, .jsx tests count, and nothing under node_modules does.
    countedTests: (f) => JS_COUNTED.test(f) && isTestFile(f) && !f.includes("node_modules/"),
    ciTest,
  },
  mutation: {
    isTest: isJsTest,
    isSource: plantable,
    covered: (tree, comp, tests) => importedFiles(tree, comp, tests, "js"),
    sites: (line) => sitesForLine(line, "ts"),
    quoted: (text) => quotedLines(text, "ts"),
    reaching: (tree, comp, tests) => reachingTests(tree, comp, tests, "js"),
    // The type-check command, or the TypeScript compiler the install put in place.
    compileProbe: (comp, { contract, root }) => {
      const typecheck = typecheckProbe(comp, contract);
      if (typecheck) return typecheck;
      if (comp.language !== "ts" || !exists(join(root, comp.path, "tsconfig.json"))) return null;
      const tsc = [comp.path, "."].map((d) => join(d, "node_modules", ".bin", "tsc")).find((p) => exists(join(root, p)));
      return tsc ? { command: `${shellQuote(tsc)} --noEmit -p ${shellQuote(join(comp.path, "tsconfig.json"))}`, cwd: "." } : null;
    },
  },
  sharedRoot: {
    // The repo's image when nothing else decides.
    repoImage: (tree, _profile, standalone) => nodeImage(tree, [".", ...standalone.filter(nodeCode).map((c) => c.path)]),
    ownImage: (tree, comp, repoImage) => (repoImage.startsWith("node:") ? null : nodeImage(tree, [comp.path])),
    doctor: (pms) => {
      const parts: string[] = [];
      if ([...pms].some((p) => p === "npm" || p === "pnpm" || p === "yarn")) parts.push("node --version");
      if (pms.has("bun")) parts.push("bun --version");
      if (pms.has("npm")) parts.push("npm --version");
      if (pms.has("pnpm")) parts.push("corepack pnpm --version");
      if (pms.has("yarn")) parts.push("corepack yarn --version");
      return parts;
    },
    setup: nodeSetup,
    commands: nodeCommands,
    testEnv: (comp, test, ctx) => ctx.ciEnvFor(comp.path, ctx.scriptCalled(test.command), test.source),
    // A workspace whose tests run from the root (`"test": "vitest"`) has packages with no test
    // script of their own. Each package that has test files gets the root run scoped to its folder,
    // so it is credited with its own tests and one failing package doesn't fail the others.
    scopedTest: (tree, comp, ctx) => {
      const root = rootTestRunner(tree);
      if (!root || !hasTestFiles(join(tree, comp.path))) return null;
      return { id: `cmd-${comp.id}-test`, kind: "test", component: comp.id, cwd: ".", command: scopedRun(ctx.profile.packageManager, root.script, comp.path), source: `package.json scripts.${root.script}`, reason: `the root ${root.runner} run, scoped to ${comp.path}`, timeoutSec: ctx.timeoutSec, tier: "manifest", confidence: "derived" };
    },
    fallback: { doctor: "node --version" },
  },
  // One older than a locked dependency's engines.node allows, as undici 8 needs 22.19 where the
  // machine has 22.14: the same lockfile passes in an image with a Node it supports.
  output: { testCounts: nodeTestCounts },
  hostGap: {
    probe: "node --version",
    gap: (root, cwd, version) => {
      const gap = lockedEngineGap(root, cwd, version);
      return gap ? { cause: "missing_tool", detail: `Node ${gap.range}, which the locked ${gap.pkg} needs, is not installed; Node ${version} is` } : null;
    },
  },
};
