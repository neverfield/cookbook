import { dirname, join } from "node:path";
import type { Component } from "../types.ts";
import { exists, readText, shellQuote, workspaceDirs } from "../util.ts";
import { withInlineTests } from "./coverage.ts";
import { braceSites, declaredBy, ownedFiles } from "./go.ts";
import type { BraceSyntax } from "./go.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Go and Rust group.

const parents = (path: string): string[] => {
  const parts = path === "." ? [] : path.split("/");
  return parts.map((_, i) => (i === 0 ? "." : parts.slice(0, i).join("/"))).reverse();
};

// The folder whose Cargo.lock a crate builds with: its own, or its workspace root's.
export function lockRoot(tree: string, path: string): string | null {
  if (exists(join(tree, path, "Cargo.lock"))) return path;
  for (const dir of parents(path)) {
    const manifest = join(tree, dir, "Cargo.toml");
    if (exists(manifest) && /^\[workspace\]/m.test(readText(manifest))) return exists(join(tree, dir, "Cargo.lock")) ? dir : null;
  }
  return null;
}

const cargo: Ecosystem = {
  id: "cargo",
  label: "Cargo",
  lockfiles: ["Cargo.lock"],
  rule: "`cargo fetch --locked` from a committed `Cargo.lock`; a workspace's members share the root's",
  install: (tree, path) => {
    const root = lockRoot(tree, path);
    if (root === null) return { command: "cargo fetch", reason: "no Cargo.lock, so the install can't be frozen", frozen: false };
    return { command: "cargo fetch --locked", reason: root === path ? "frozen fetch from Cargo.lock" : `frozen fetch from the workspace's Cargo.lock in ${root}`, frozen: true };
  },
  unpinned: (tree, path) => (lockRoot(tree, path) === null ? "no Cargo.lock is committed" : null),
};

const manifestOf = (tree: string, dir: string) => (exists(join(tree, dir, "Cargo.toml")) ? readText(join(tree, dir, "Cargo.toml")) : "");
const isWorkspace = (tree: string, dir: string) => /^\[workspace\]/m.test(manifestOf(tree, dir));

// The crates a workspace root lists in [workspace] members, less its excludes, relative to the tree.
export function workspaceMembers(tree: string, dir: string): string[] {
  const section = manifestOf(tree, dir).match(/^\[workspace\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  if (section === undefined) return [];
  const list = (key: string) => [...(section.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"))?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const root = join(tree, dir);
  return workspaceDirs(root, [...list("members"), ...list("exclude").map((p) => `!${p}`)], (d) => exists(join(root, d, "Cargo.toml"))).map((d) => (dir === "." ? d : `${dir}/${d}`));
}

// A workspace root runs every member, as `cargo test --workspace`; a lone crate runs itself.
const scope = (tree: string, comp: Component) => (isWorkspace(tree, comp.path) ? " --workspace" : "");

// Where the repo says it runs clippy: a task file that runs it, a clippy config, or a toolchain
// file that installs it.
export function clippyDeclared(tree: string, dir: string): string | null {
  for (const f of ["clippy.toml", ".clippy.toml"]) if (exists(join(tree, dir, f))) return dir === "." ? f : `${dir}/${f}`;
  const toolchain = toolchainFile(tree, dir);
  if (toolchain && /^\s*components\s*=\s*\[[^\]]*["']clippy["']/m.test(readText(join(tree, toolchain)))) return toolchain;
  return declaredBy(tree, dir, /\bcargo[ +\w.-]* clippy\b|\bclippy-action\b/);
}

// rustup reads the nearest rust-toolchain.toml, or the older rust-toolchain, from the crate's folder up.
export function toolchainFile(tree: string, dir: string): string | null {
  for (const d of [dir, ...parents(dir)]) {
    for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
      const rel = d === "." ? name : `${d}/${name}`;
      if (exists(join(tree, rel))) return rel;
    }
  }
  return null;
}

export function rustChannel(tree: string, dir: string): string | null {
  const file = toolchainFile(tree, dir);
  if (!file) return null;
  const text = readText(join(tree, file));
  return text.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1] ?? (/^[\w.-]+\s*$/.test(text.trim()) ? text.trim() : null);
}

// Pinned on Nov 15, 2026 (`docker buildx imagetools inspect`): multi-arch indexes with amd64 and arm64.
const RUST_IMAGES: Record<string, string> = {
  "rust:1.93-bookworm": "sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31",
  "rust:1.94-bookworm": "sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55",
  "rust:1.95-bookworm": "sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1",
  "rust:1.96-bookworm": "sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663",
  "rust:1.97-bookworm": "sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97",
};
const NEWEST_RUST = Object.keys(RUST_IMAGES).at(-1)!;

// The pinned image of the Rust a toolchain file names, else the newest. The image's toolchain is its
// exact release, such as 1.95.0, so a file naming that release runs offline on the image. Any other
// name, such as 1.95, stable or a nightly, is a channel rustup downloads during setup, with the
// network on, as it would in CI; rustup won't link a channel's name to the image's toolchain.
export function rustImage(tree: string, dir: string): string {
  const minor = rustChannel(tree, dir)?.match(/^1\.(\d+)(\.\d+)?$/)?.[1];
  const tag = minor ? `rust:1.${minor}-bookworm` : NEWEST_RUST;
  return RUST_IMAGES[tag] ? tag : NEWEST_RUST;
}

// One `test result:` line per test binary, unit tests, integration tests and doc tests alike.
export function rustTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const m of output.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm)) {
    seen = true;
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  return seen ? { passed, failed, total: passed + failed } : null;
}

// The opening of a raw string, r"..." or br#"..."#, up to its quote.
const RAW = /(?:^|[^\w])b?r(#*)$/;

// Whether index `at` of a line is inside a string or a character literal. A quote that isn't a
// one-character or escaped literal starts a lifetime or a label, as in `&'a str`.
export function rustInString(line: string, at: number): boolean {
  for (let i = 0; i < at; i++) {
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") return false;
    if (ch === '"') {
      const raw = line.slice(0, i).match(RAW);
      const close = raw ? `"${raw[1]}` : '"';
      for (i++; i < line.length && !line.startsWith(close, i); i++) if (!raw && line[i] === "\\") i++;
      if (i >= at) return true;
      i += close.length - 1;
    } else if (ch === "'") {
      const end = line[i + 1] === "\\" ? line.indexOf("'", i + 2) : line[i + 2] === "'" ? i + 2 : -1;
      if (end < 0) continue;
      if (end >= at) return true;
      i = end;
    }
  }
  return false;
}

const RUST_SYNTAX: BraceSyntax = {
  skip: /^((pub(\([\w:]+\))?\s+)?(use|mod|extern crate)\b|#!?\[|macro_rules!)/,
  inString: rustInString,
  head: /^(\s*(?:\}\s*else\s+)?(?:if|while)\s+)(.+?)(\s*\{\s*)$/,
  keepCondition: /^let\b/,
};

// Whether code under a `#[cfg(...)]` predicate is compiled when the audit builds and tests the crate:
// true, false, or null when that depends on something the audit doesn't fix. Faults go only where it
// is true, so none lands in code the tests never compile. `features` are the crate's default
// features; null means they aren't known, so any feature makes the answer null. Every container is
// Linux, but its architecture follows the machine (arm64 on a Mac), so target_arch and the like are
// null, and the same code gets the same faults on every machine.
export function cfgActive(pred: string, features: Set<string> | null): boolean | null {
  let i = 0;
  const ws = () => {
    while (/\s/.test(pred[i] ?? "")) i++;
  };
  const ident = () => {
    ws();
    const m = pred.slice(i).match(/^[A-Za-z_][\w]*/);
    i += m ? m[0].length : 0;
    return m?.[0] ?? "";
  };
  const str = () => {
    ws();
    const m = pred.slice(i).match(/^"([^"]*)"/);
    i += m ? m[0].length : 0;
    return m?.[1] ?? null;
  };
  const list = (): (boolean | null)[] => {
    const out: (boolean | null)[] = [];
    ws();
    if (pred[i] !== "(") return out;
    i++;
    for (ws(); i < pred.length && pred[i] !== ")"; ws()) {
      out.push(expr());
      ws();
      if (pred[i] === ",") i++;
    }
    i++;
    return out;
  };
  const expr = (): boolean | null => {
    const name = ident();
    ws();
    if (name === "all" || name === "any" || name === "not") {
      const args = list();
      if (name === "not") return args[0] === null || args[0] === undefined ? null : !args[0];
      if (name === "all") return args.includes(false) ? false : args.includes(null) ? null : true;
      return args.includes(true) ? true : args.includes(null) ? null : false;
    }
    if (pred[i] === "=") {
      i++;
      const value = str();
      if (value === null) return null;
      if (name === "feature") return features ? features.has(value) : null;
      if (name === "target_os") return value === "linux";
      if (name === "target_family") return value === "unix";
      return null;
    }
    if (name === "unix" || name === "debug_assertions") return true;
    if (name === "windows" || name === "test" || name === "miri" || name === "doc" || name === "docsrs") return false;
    return null;
  };
  const result = expr();
  return result;
}

// A crate's default features, with the features they turn on, from its Cargo.toml.
export function defaultFeatures(tree: string, dir: string): Set<string> {
  const section = manifestOf(tree, dir).match(/^\[features\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  const table = new Map<string, string[]>();
  for (const m of section.matchAll(/^([\w-]+)\s*=\s*\[([\s\S]*?)\]/gm)) table.set(m[1], [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
  const on = new Set<string>();
  const add = (f: string) => {
    if (f.startsWith("dep:") || f.includes("/") || on.has(f)) return;
    on.add(f);
    for (const g of table.get(f) ?? []) add(g);
  };
  for (const f of table.get("default") ?? []) add(f);
  return on;
}

// The cfg predicate of an attribute that starts at `at` (`#[cfg(` or `#![cfg(`), and where it ends.
function cfgAt(text: string, at: number): { pred: string; end: number } | null {
  const open = text.indexOf("(", at);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return { pred: text.slice(open + 1, j), end: j };
  }
  return null;
}

// 0-based lines a fault must never land on: block comments, nested or not, and strings that span
// lines, and every line of an item under a `#[cfg(...)]` that isn't compiled on every machine the
// audit runs on. That covers `#[cfg(test)]` items, which are test code even in a source file, and
// items behind a feature, which the quoting can't tell is on (rustCovered drops whole modules a
// default feature leaves out).
export function rustQuoted(text: string): Set<number> {
  const out = new Set<number>();
  const span = (from: number, to: number, always = false) => {
    for (let l = from; (always || to > from) && l <= to; l++) out.add(l);
  };
  let line = 0;
  let depth = 0;
  let pendingTest: number | null = null;
  const tests: { from: number; depth: number }[] = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < n && text[i + 1] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const from = line;
      let nest = 1;
      for (i += 2; i < n && nest > 0; i++) {
        if (text[i] === "\n") line++;
        else if (text.startsWith("/*", i)) (nest++, i++);
        else if (text.startsWith("*/", i)) (nest--, i++);
      }
      i--;
      span(from, line);
    } else if (ch === '"') {
      const raw = text.slice(Math.max(0, i - 260), i).match(RAW);
      const close = raw ? `"${raw[1]}` : '"';
      const from = line;
      for (i++; i < n && !text.startsWith(close, i); i++) {
        if (!raw && text[i] === "\\") i++;
        if (text[i] === "\n") line++;
      }
      i += close.length - 1;
      span(from, line);
    } else if (ch === "'") {
      const end = text[i + 1] === "\\" ? text.indexOf("'", i + 2) : text[i + 2] === "'" ? i + 2 : -1;
      if (end > 0 && !text.slice(i, end).includes("\n")) i = end;
    } else if (text.startsWith("#[cfg(", i)) {
      const attr = cfgAt(text, i);
      if (attr && cfgActive(attr.pred, null) !== true) pendingTest ??= line;
      if (attr) i = attr.end;
    } else if (ch === ";" && pendingTest !== null) {
      span(pendingTest, line, true);
      pendingTest = null;
    } else if (ch === "{") {
      if (pendingTest !== null) tests.push({ from: pendingTest, depth });
      pendingTest = null;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (tests.length && tests.at(-1)!.depth === depth) span(tests.pop()!.from, line, true);
    }
  }
  return out;
}

const GENERATED_PATH = /(^|\/)(target|tests|benches|examples)\//;
// Integration tests under tests/, and a test module kept in its own file (`#[cfg(test)] mod tests;`
// loads src/tests.rs or src/foo/tests.rs).
const isRustTest = (f: string) => (/(^|\/)tests\/.+\.rs$/.test(f) || /(^|\/)src\/(.+\/)?tests\.rs$/.test(f)) && !/(^|\/)target\//.test(f);
const isRustSource = (f: string) => f.endsWith(".rs") && !GENERATED_PATH.test(f) && !/(^|\/)build\.rs$/.test(f) && !isRustTest(f);

// The folder of the nearest Cargo.toml above a file: the crate it belongs to.
function crateOf(tree: string, file: string): string | null {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (exists(join(tree, d, "Cargo.toml"))) return d;
    if (d === "." || d === "") return null;
  }
}

// What a crate's tests cover: files that hold their own #[cfg(test)] tests. A crate tested only from
// test files of its own (tests/*.rs, a tests.rs module) has none, since those tests reach its code
// through its public API or `use super::*`, not by file, so every source file it compiles counts.
// Only the component's crate and its workspace members count, as only they are built and tested.
export function rustCovered(tree: string, path: string, tests: string[], files: string[]): string[] {
  const members = new Set(workspaceMembers(tree, path));
  const owned = (d: string) => d === path || members.has(d);
  const sources = ownedFiles(tree, files, "Cargo.toml", owned).filter(isRustSource);
  const compiled = compiledModules(tree, sources);
  const tested = new Set(tests.map((t) => crateOf(tree, t)).filter((d): d is string => d !== null && owned(d)));
  const inline = withInlineTests(tree, sources, isRustSource, INLINE_TESTS);
  const inlineCrates = new Set(inline.map((f) => crateOf(tree, f)));
  const out = new Set(inline);
  for (const f of sources) {
    const crate = crateOf(tree, f);
    if (tested.has(crate!) && !inlineCrates.has(crate)) out.add(f);
  }
  return [...out].filter(compiled).sort();
}

// The folder a file's `mod x;` declarations load from: its own folder for lib.rs, main.rs and
// mod.rs, else a folder named after it.
const moduleDir = (f: string) => (/(^|\/)(lib|main|mod)\.rs$/.test(f) ? dirname(f) : f.replace(/\.rs$/, ""));

// Which sources the default build compiles: a file a `#[cfg(...)] mod x;` declares, or one that
// opens with `#![cfg(...)]`, is left out with everything under it unless the predicate holds with
// the crate's default features.
function compiledModules(tree: string, sources: string[]): (f: string) => boolean {
  const off: string[] = [];
  for (const f of sources) {
    const text = readText(join(tree, f));
    const crate = crateOf(tree, f);
    const features = crate === null ? null : defaultFeatures(tree, crate);
    const inner = text.match(/^\s*(?:\/\/[^\n]*\n\s*)*#!\[cfg\(/);
    if (inner) {
      const attr = cfgAt(text, inner.index! + inner[0].length - 6);
      if (attr && cfgActive(attr.pred, features) !== true) off.push(f.replace(/\.rs$/, ""));
    }
    for (const m of text.matchAll(/#\[cfg\(/g)) {
      const attr = cfgAt(text, m.index!);
      if (!attr) continue;
      const decl = text.slice(attr.end + 2).match(/^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)\s*;/);
      if (decl && cfgActive(attr.pred, features) !== true) off.push(`${moduleDir(f)}/${decl[1]}`);
    }
  }
  return (f) => !off.some((m) => f === `${m}.rs` || f.startsWith(`${m}/`) || f === m);
}
const INLINE_TESTS = /#\[cfg\(test\)\]/;

export const rust: LanguageDef = {
  id: "rust",
  label: "Rust",
  codes: ["rust"],
  stacks: [{ id: "rust", label: "Rust", kind: "stack", tier: "supported", reason: "a Cargo.toml folder is a component, and a workspace root covers every member (`--workspace`); it runs in the pinned rust image of the release its toolchain file names (the newest otherwise, with rustup adding any other channel): `cargo build`, `cargo test`, and `cargo clippy` where the repo runs it, with faults planted only in member source files that hold their own tests, or in every source file of a member tested only from tests/", files: /\.rs$|(^|\/)Cargo\.(toml|lock)$/, proof: ["fixtures/rust-pricing", "BurntSushi/ripgrep@91f5d22"] }],
  detect: {
    manifests: [{ match: /^Cargo\.toml$/, stack: "rust", rank: 30 }],
    sources: [{ ext: /\.rs$/, stack: "rust", rank: 30 }],
    rootApp: { names: ["Cargo.toml"], stack: "rust", toolchain: "Rust", suffix: "rust", rank: 40 },
    runners: /\bcargo\s+(test|nextest)\b/,
    lockfiles: ["Cargo.lock"],
    projectName: (_tree, manifest, text) => (manifest === "Cargo.toml" ? text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] : undefined),
    // A nested crate outside any workspace is built and tested apart. A workspace builds its members,
    // and a crate it excludes is left out on purpose, as an npm workspace's `!` pattern is.
    ownUnit: (tree, parent) => !isWorkspace(tree, parent),
  },
  ecosystems: [cargo],
  checks: {
    weakening: { isTest: isRustTest, markers: null },
    lockfiles: { diff: ["Cargo.lock"], secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: /^(cargo|rustc|rustup)$/,
    countedTests: isRustTest,
    ciTest: null,
  },
  mutation: {
    isTest: isRustTest,
    isSource: isRustSource,
    covered: (tree, comp, tests, files) => rustCovered(tree, comp.path, tests, files),
    sites: (line) => braceSites(line, RUST_SYNTAX),
    quoted: rustQuoted,
    // A lone crate is a workspace of one, so this checks it, or every member a fault can be in.
    compileProbe: (comp) => ({ command: "cargo check --locked --offline -q --workspace", cwd: comp.path }),
    compileError: (output) => /^error\[E\d+\]|^error: could not compile /m.test(output),
  },
  replay: {
    classify: () => ({ language: "rust", packageManager: "cargo" }),
    image: rustImage,
    images: RUST_IMAGES,
    doctor: "cargo --version && rustc --version",
    pins: (tree, dir) => {
      const file = toolchainFile(tree, dir);
      return file ? { found: [file], missing: [] } : { found: [], missing: ["the Rust toolchain (rust-toolchain.toml)"] };
    },
    commands: (tree, comp) => {
      const ws = scope(tree, comp);
      const what = ws ? "every workspace member" : "the crate";
      const clippy = clippyDeclared(tree, comp.path);
      return [
        { kind: "build", command: `cargo build --locked${ws}`, source: "readiness", reason: `Cargo's build of ${what}, from the committed Cargo.lock` },
        ...(clippy ? [{ kind: "lint" as const, command: `cargo clippy --locked --offline${ws}`, source: clippy, reason: `the repo runs clippy (${clippy}); its default lints on ${what}, which report and never rewrite, and only lints that deny by default fail it` }] : []),
        { kind: "test", command: `cargo test --locked --offline -q${ws}`, source: "readiness", reason: `unit, integration and doc tests of ${what}, each binary ending in a count of what passed` },
      ];
    },
    testCounts: rustTestCounts,
    // The rust image ships rustc and cargo only. rustup adds clippy to the toolchain the crate's
    // toolchain file names, downloading that toolchain first when it isn't the image's own.
    setup: (tree, dir) => clippyDeclared(tree, dir) === null ? [] : [{ tool: "clippy", spec: rustChannel(tree, dir) ? `clippy for Rust ${rustChannel(tree, dir)}` : "clippy", install: `${dir === "." ? "" : `cd ${shellQuote(dir)} && `}rustup component add clippy` }],
    budget: { commandTimeoutSec: 1200, componentMinutes: 30, mutationRunTimeoutSec: 600 },
  },
};
