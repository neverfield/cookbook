// The interface every file in this folder implements: one file per language, listed once in
// index.ts. A language group adds or changes its own file and nothing shared. The rules a file
// must follow, and the recipe for a new one, are in tests/languages.test.ts and the handoff notes.
//
// A language file may import only `../util.ts`, its siblings in this folder, and types. Anything
// else (profile, contract, replay) imports the registry, so importing it back would be a cycle.
import type { Site } from "../mutate.ts";
import type { Stack } from "../support.ts";
import type { CommandKind, Component, Language, PackageManager } from "../types.ts";

// A frozen install, or the closest the folder allows, and why.
export interface InstallPlan {
  command: string;
  reason: string;
  // The install can't change what the committed files pin: `npm ci`, `cargo fetch --locked`. An
  // install that isn't frozen still decides Level 1, and fails the lockfile condition of Level 2.
  frozen: boolean;
}

// One package ecosystem: what counts as a reproducible install for it. Level 1's clean install is
// `install` passing in a clean container. Level 2's lockfile condition is `unpinned` returning null,
// a frozen install, and every file in `lockfiles` unchanged after the install.
export interface Ecosystem {
  id: PackageManager;
  label: string;
  // Files a frozen install must leave byte for byte, relative to the installed folder.
  lockfiles: string[];
  // The rule in one sentence, as references/levels.md states it.
  rule: string;
  install(tree: string, path: string, opts: { ignoreScripts: boolean }): InstallPlan;
  // Why the committed files don't pin every dependency, or null when they do. Read before anything runs.
  unpinned(tree: string, path: string): string | null;
}

export interface Detect {
  // Manifests that make a folder a project of this language. A lower rank is tried first, so a
  // .sln claims its folder before a .csproj does, and go.mod before a stray .tf file.
  manifests?: { match: RegExp; stack: string; rank: number }[];
  // Source files that make a top-level folder with no manifest a project of this language.
  sources?: { ext: RegExp; stack: string; rank: number }[];
  // A project at the root next to a root package.json, listed with its own share of changes.
  rootApp?: { names: string[]; stack: string; toolchain: string; suffix: string; rank: number };
  // Lockfile names, so a component reports the one it has.
  lockfiles?: string[];
  // The name a root-level project gives itself, read from its manifest (a path relative to the tree).
  projectName?(tree: string, manifest: string, text: string, repoName: string): string | undefined;
  // A different stack of this language for one manifest, such as Android for a Gradle build that
  // applies the Android plugin, or Windows-only .NET for a solution whose every project needs Windows.
  refine?(manifest: string, text: string, tree?: string): string | undefined;
  // Folders inside a found project that are listed as components of their own in another stack of
  // this language (tree-relative), such as a Windows-only project in a solution that otherwise
  // builds on Linux.
  parts?(tree: string, dir: string): { path: string; manifest: string; stack: string }[];
  // Facts read from the files of a component in a stack that isn't scored, such as which lockfiles
  // it commits, so the report says what was checked without running anything.
  notes?(tree: string, dir: string, stack: string): string[];
  // A manifest that only lists other projects, such as a Dart workspace's root pubspec.yaml.
  workspaceOnly?(manifest: string, text: string): boolean;
}

// A command the language discovers for a component, before the contract gives it an id and timeout.
export interface DraftCommand {
  kind: Exclude<CommandKind, "doctor" | "install" | "start">;
  command: string;
  // Where the command comes from: a manifest line such as `Cargo.toml`, or `readiness` for the
  // toolchain's standard command.
  source: string;
  reason: string;
  // Relative to the component; the component's folder when omitted.
  cwd?: string;
}

// A tool a frozen install needs that the image doesn't ship, added as the image's user with the
// network on before the install runs. When it can't be added, the install is blocked, not failed.
export interface ToolSetup {
  tool: string;
  spec: string;
  install: string;
}

// Raised floors for a slow toolchain, such as a cold JVM or .NET build. The rubric's values apply
// when they are higher.
export interface ToolchainBudget {
  commandTimeoutSec?: number;
  componentMinutes?: number;
  mutationRunTimeoutSec?: number;
}

export interface MutationHooks {
  isTest(path: string): boolean;
  // A file a fault may go in: source of this language, not generated, not a test.
  isSource(path: string): boolean;
  // The source files the component's tests cover, relative to the tree. Faults go only there.
  covered(tree: string, comp: Component, tests: string[], files: string[]): string[];
  // Fault sites on one line. Omitted: the C-like operators (`if (`, `return true`, `throw ...;`).
  sites?(line: string): Omit<Site, "file" | "line">[];
  // 0-based lines that are text rather than code (block comments, multi-line strings). Omitted: the
  // C-like scanner, which treats `/* */`, quotes and backticks as JavaScript does.
  quoted?(text: string): Set<number>;
  // How to tell a planted fault compiles, run before the tests. A fault that doesn't compile is
  // discarded, never counted as caught.
  compileProbe(comp: Component): { command: string; cwd: string } | null;
  // Whether a probe's or test run's output says the code doesn't compile, such as Go's
  // "undefined: x". Omitted: only TypeScript's and Python's errors count.
  compileError?(output: string): boolean;
}

// How the replay runs a component of this language. Required once a stack of the language moves to
// the supported tier; Node and Python predate it and are scored by contract.ts (`builtIn`).
export interface ReplayHooks {
  // The component's language and ecosystem, from the folder its manifest is in.
  classify(tree: string, dir: string, manifest: string): { language: Language; packageManager: PackageManager | null };
  // The image tag the component runs in. Every tag it can return is in `images`.
  image(tree: string, dir: string): string;
  // Tag to multi-arch (amd64 and arm64) index digest, so a replay runs on the same bytes everywhere.
  images: Record<string, string>;
  // Proves the toolchain is in the image, such as `go version`.
  doctor: string;
  // The toolchain condition: files that pin the toolchain's version (`found`, tree-relative), and
  // what is missing, phrased to follow "missing ", such as "the Go version (the go line in go.mod)".
  pins(tree: string, dir: string): { found: string[]; missing: string[] };
  commands(tree: string, comp: Component): DraftCommand[];
  // The test runner's own count, so a run that reports failures and exits 0 still fails, and the
  // report says how many passed. Omitted: the runners diagnose.ts knows.
  testCounts?(output: string): { passed: number; failed: number; total: number } | null;
  setup?(tree: string, dir: string): ToolSetup[];
  budget?: ToolchainBudget;
  mutation: MutationHooks;
}

export interface LanguageDef {
  // The file's name: `go` for go.ts.
  id: string;
  label: string;
  // The component languages this file scores. Each code belongs to one file.
  codes: Language[];
  // The support entries the scan can put a component of this language in (references/supported.md).
  stacks: Stack[];
  detect: Detect;
  ecosystems: Ecosystem[];
  replay?: ReplayHooks;
  // Node and Python: detected, installed and tested by profile.ts and contract.ts.
  builtIn?: boolean;
}
