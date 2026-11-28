import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Site } from "../mutate.ts";
import { exists, readText } from "../util.ts";
import { sameFolder } from "./coverage.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Go and Rust group.

function requires(tree: string, path: string): boolean {
  const mod = join(tree, path, "go.mod");
  return exists(mod) && /^require\b/m.test(readText(mod));
}

const vendored = (tree: string, path: string) => exists(join(tree, path, "vendor", "modules.txt"));

const goModules: Ecosystem = {
  id: "go",
  label: "Go modules",
  lockfiles: ["go.mod", "go.sum"],
  rule: "`go mod download` with `-mod=readonly`, from a committed `go.sum` that covers every module `go.mod` requires; a committed `vendor/modules.txt` counts as the lock",
  install: (tree, path) => {
    if (vendored(tree, path)) return { command: "go mod verify && go list -mod=vendor ./... >/dev/null", reason: "vendored modules in vendor/, checked against go.sum", frozen: true };
    if (!requires(tree, path)) return { command: "GOFLAGS=-mod=readonly go mod download", reason: "go.mod requires no modules", frozen: true };
    return exists(join(tree, path, "go.sum"))
      ? { command: "GOFLAGS=-mod=readonly go mod download", reason: "download of the modules go.sum pins, without changing go.mod", frozen: true }
      : { command: "go mod download", reason: "no go.sum, so the install can't be frozen", frozen: false };
  },
  unpinned: (tree, path) => (requires(tree, path) && !exists(join(tree, path, "go.sum")) && !vendored(tree, path) ? "go.mod requires modules but no go.sum is committed" : null),
};

// The CI configs and task files that say which checks a project runs, relative to the tree: at the
// root, and in the component's folder.
export function taskFiles(tree: string, dir: string): string[] {
  const out: string[] = [];
  for (const d of dir === "." ? ["."] : [".", dir]) {
    const rel = (f: string) => (d === "." ? f : `${d}/${f}`);
    for (const f of [".circleci/config.yml", ".gitlab-ci.yml", "Makefile", "justfile", "Justfile", "Taskfile.yml", "magefile.go"]) if (exists(join(tree, d, f))) out.push(rel(f));
    const wf = join(tree, d, ".github", "workflows");
    if (exists(wf)) for (const f of readdirSync(wf).filter((x) => /\.ya?ml$/.test(x)).sort()) out.push(rel(`.github/workflows/${f}`));
  }
  return out;
}

// The first task file that runs a check, such as `go vet`: the audit runs a linter only when the
// repo does, as it runs a Node package's lint only when the package declares one.
function hasGoSource(dir: string, depth = 0): boolean {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return false;
  }
  if (names.some((n) => n.endsWith(".go"))) return true;
  return depth < 8 && names.some((n) => n.endsWith("/") && !/^(\.|vendor\/|testdata\/)/.test(n) && hasGoSource(join(dir, n.slice(0, -1)), depth + 1));
}

export function declaredBy(tree: string, dir: string, check: RegExp): string | null {
  return taskFiles(tree, dir).find((f) => check.test(readText(join(tree, f)))) ?? null;
}

// The files whose nearest `manifest` (go.mod, Cargo.toml) is in a folder `accept` takes, so faults
// go only in code the component's own commands build and test, never in a nested module or crate.
export function ownedFiles(tree: string, files: string[], manifest: string, accept: (dir: string) => boolean): string[] {
  const owner = new Map<string, string | null>();
  const nearest = (dir: string): string | null => {
    if (!owner.has(dir)) owner.set(dir, exists(join(tree, dir, manifest)) ? dir : dir === "." ? null : nearest(dirname(dir)));
    return owner.get(dir)!;
  };
  return files.filter((f) => {
    const d = nearest(dirname(f));
    return d !== null && accept(d);
  });
}

// Fault sites for a language with C-like operators whose `if` takes no parentheses, as Go and Rust
// write it. Each language says which lines hold no behaviour, where its strings are, and which
// condition heads may be negated.
export interface BraceSyntax {
  skip: RegExp;
  inString(line: string, index: number): boolean;
  // Group 1 is everything before the condition, group 2 the condition, group 3 the opening brace.
  head: RegExp;
  // A condition that can't be negated as a whole, such as Rust's `if let` pattern.
  keepCondition?: RegExp;
}

type Draft = Omit<Site, "file" | "line">;

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };

// A delay, timeout or retry interval one unit longer behaves the same to any test that isn't timing
// the code, so the mutant could only survive.
const TIMING = /(sleep|delay|timeout|deadline|interval|backoff|\bttl\b|time\.(Nanosecond|Microsecond|Millisecond|Second|Minute|Hour)|Duration::from_)/i;

// Where the code on a line ends: at a `//` comment outside a string.
function codeEnd(line: string, syn: BraceSyntax): number {
  for (let i = line.indexOf("//"); i >= 0; i = line.indexOf("//", i + 2)) if (!syn.inString(line, i)) return i;
  return line.length;
}

function first(line: string, re: RegExp, syn: BraceSyntax, end: number): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(line)) && m.index < end) if (!syn.inString(line, m.index)) return m;
  return null;
}

export function braceSites(line: string, syn: BraceSyntax): Draft[] {
  const trimmed = line.trim();
  if (!trimmed || /^(\/\/|\/\*|\*)/.test(trimmed) || syn.skip.test(trimmed)) return [];
  const end = codeEnd(line, syn);
  const out: Draft[] = [];
  const at = (index: number, length: number, text: string) => line.slice(0, index) + text + line.slice(index + length);
  const b = first(line, / (<=|>=|<|>) /, syn, end);
  if (b) out.push({ operator: "boundary_flip", before: line, after: at(b.index, b[0].length, ` ${BOUNDARY[b[1]]} `) });
  const h = line.slice(0, end).match(syn.head);
  if (h && !syn.inString(line, h[1].length)) {
    let [, pre, cond] = h;
    // Go's `if v, ok := m[k]; ok {`: only the part after the init statement is the condition.
    const semi = cond.lastIndexOf(";");
    if (semi >= 0 && !syn.inString(line, pre.length + semi)) {
      pre += cond.slice(0, semi + 1) + " ";
      cond = cond.slice(semi + 1).trim();
    }
    if (cond && !cond.includes("{") && !syn.keepCondition?.test(cond)) out.push({ operator: "negate_condition", before: line, after: `${pre}!(${cond})${line.slice(h[0].length - h[3].length)}` });
  }
  const s = first(line, / ([+-]) 1(?![\d.])/, syn, end);
  if (s) out.push({ operator: "shift_by_one", before: line, after: at(s.index, s[0].length, ` ${s[1] === "+" ? "-" : "+"} 1`) });
  const r = first(line, /\breturn (true|false)\b/, syn, end);
  if (r) out.push({ operator: "swap_return", before: line, after: at(r.index, r[0].length, `return ${r[1] === "true" ? "false" : "true"}`) });
  const c = first(line, /(?<![\w.$])(\d+)(?![\w.])/, syn, end);
  if (c && !/^(case |default\b)/.test(trimmed) && !TIMING.test(line)) {
    const n = Number(c[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: at(c.index, c[0].length, String(n + 1)) });
  }
  return out.filter((x) => x.after !== x.before);
}

// Whether index `at` of a Go line is inside a string, raw string or rune literal.
export function goInString(line: string, at: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < at; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "/" && line[i + 1] === "/") return false;
  }
  return quote !== null;
}

const GO_SYNTAX: BraceSyntax = {
  skip: /^(package |import\b|\/\/go:|\/\/ \+build)/,
  inString: goInString,
  head: /^(\s*(?:\}\s*else\s+)?if\s+)(.+?)(\s*\{\s*)$/,
};

// 0-based lines inside a block comment or a raw string that spans lines.
export function goQuoted(text: string): Set<number> {
  const out = new Set<number>();
  const span = (from: number, to: number) => {
    for (let l = from; to > from && l <= to; l++) out.add(l);
  };
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    else if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const from = line;
      for (i += 2; i < text.length && !text.startsWith("*/", i); i++) if (text[i] === "\n") line++;
      i++;
      span(from, line);
    } else if (ch === "`") {
      const from = line;
      for (i++; i < text.length && text[i] !== "`"; i++) if (text[i] === "\n") line++;
      span(from, line);
    } else if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      if (text[i] === "\n") line++;
    }
  }
  return out;
}

// Pinned on Nov 15, 2026 (`docker buildx imagetools inspect`): multi-arch indexes with amd64 and arm64.
const GO_IMAGES: Record<string, string> = {
  "golang:1.21-bookworm": "sha256:c6a5b9308b3f3095e8fde83c8bf4d68bd101fce606c1a0a1394522542509dda9",
  "golang:1.22-bookworm": "sha256:3d699e4d15d0f8f13c9195c0632a16702b8cbdece2955af1c23b37ae5d55a253",
  "golang:1.23-bookworm": "sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db",
  "golang:1.24-bookworm": "sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac",
  "golang:1.25-bookworm": "sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437",
  "golang:1.26-bookworm": "sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0",
  "golang:1.27-bookworm": "sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea",
};
const GO_MINORS = Object.keys(GO_IMAGES).map((t) => Number(t.match(/1\.(\d+)/)![1]));

const goMod = (tree: string, dir: string) => (exists(join(tree, dir, "go.mod")) ? readText(join(tree, dir, "go.mod")) : "");

// The Go minor the module asks for: the higher of its go line and its toolchain line.
export function goMinor(tree: string, dir: string): number | null {
  const text = goMod(tree, dir);
  const minors = [text.match(/^go\s+1\.(\d+)/m)?.[1], text.match(/^toolchain\s+go1\.(\d+)/m)?.[1]].filter((x): x is string => Boolean(x)).map(Number);
  return minors.length ? Math.max(...minors) : null;
}

// The image's Go never fetches a newer toolchain (GOTOOLCHAIN=local), so the image is the first
// pinned Go at or above the module's: the one it names when pinned, else the closest newer one.
export function goImage(tree: string, dir: string): string {
  const want = goMinor(tree, dir) ?? GO_MINORS.at(-1)!;
  const minor = GO_MINORS.find((m) => m >= want) ?? GO_MINORS.at(-1)!;
  return `golang:1.${minor}-bookworm`;
}

// `go test -v` prints one `--- PASS` or `--- FAIL` line per top-level test at column 0; subtests
// are indented under their parent.
export function goTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const passed = output.match(/^--- PASS: /gm)?.length ?? 0;
  const failed = output.match(/^--- FAIL: /gm)?.length ?? 0;
  return passed + failed ? { passed, failed, total: passed + failed } : null;
}

const GENERATED = /(\.pb\.go|_gen\.go|_generated\.go|zz_generated[^/]*\.go|_string\.go)$/;
const outsideModule = (f: string) => /(^|\/)(vendor|testdata)\//.test(f);
const isGoTest = (f: string) => f.endsWith("_test.go") && !outsideModule(f);
const isGoSource = (f: string) => f.endsWith(".go") && !f.endsWith("_test.go") && !outsideModule(f) && !GENERATED.test(f);

export const go: LanguageDef = {
  id: "go",
  label: "Go",
  codes: ["go"],
  stacks: [{ id: "go", label: "Go", kind: "stack", tier: "supported", reason: "a go.mod folder is a component, run in the first pinned golang image at or above its go line (the newest without one): `go build`, `go test`, and `go vet` where the repo runs it, with faults planted only in the module's packages that have tests", files: /\.go$|(^|\/)go\.(mod|sum)$/, proof: ["fixtures/go-inventory", "google/uuid@2d3c2a9"] }],
  detect: {
    manifests: [{ match: /^go\.mod$/, stack: "go", rank: 20 }],
    sources: [{ ext: /\.go$/, stack: "go", rank: 20 }],
    rootApp: { names: ["go.mod"], stack: "go", toolchain: "Go", suffix: "go", rank: 30 },
    runners: /\bgo\s+test\b|\bgotestsum\b/,
    lockfiles: ["go.sum"],
    projectName: (_tree, manifest, text) => (manifest === "go.mod" ? text.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop() : undefined),
    // `go test ./...` stops at a nested go.mod: that folder is another module, built and tested apart.
    // One with no Go source, such as assets/ holding only a logo, only keeps its folder out of the module.
    ownUnit: (tree, _parent, dir) => hasGoSource(join(tree, dir)),
  },
  ecosystems: [goModules],
  checks: {
    weakening: { isTest: isGoTest, markers: null },
    lockfiles: { diff: ["go.sum"], secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: /^(go|gofmt|golangci-lint)$/,
    countedTests: isGoTest,
  },
  mutation: {
    isTest: isGoTest,
    isSource: isGoSource,
    covered: (tree, comp, tests, files) => sameFolder(tests, ownedFiles(tree, files, "go.mod", (d) => d === comp.path), isGoSource),
    sites: (line) => braceSites(line, GO_SYNTAX),
    quoted: goQuoted,
    compileProbe: (comp) => ({ command: "go build ./...", cwd: comp.path }),
    compileError: (output) => /\[build failed\]|^(\.\/)?[\w./-]+\.go:\d+:\d+: /m.test(output),
  },
  replay: {
    classify: () => ({ language: "go", packageManager: "go" }),
    image: goImage,
    images: GO_IMAGES,
    doctor: "go version",
    pins: (tree, dir) => {
      const rel = dir === "." ? "go.mod" : `${dir}/go.mod`;
      return /^go\s+1\.\d+/m.test(goMod(tree, dir)) ? { found: [rel], missing: [] } : { found: [], missing: ["the Go version (the go line in go.mod)"] };
    },
    commands: (tree, comp) => {
      const vet = declaredBy(tree, comp.path, /\bgo vet\b/);
      return [
        { kind: "build", command: "go build ./...", source: "readiness", reason: "the Go toolchain's build of every package in the module" },
        ...(vet ? [{ kind: "lint" as const, command: "go vet ./...", source: vet, reason: `the repo runs go vet in ${vet}; it reports and never rewrites` }] : []),
        { kind: "test", command: "go test -count=1 -v ./...", source: "readiness", reason: "every package's tests, uncached, listed one per line so the report can count them; go test also runs vet's high-confidence checks" },
      ];
    },
    testCounts: goTestCounts,
  },
};
