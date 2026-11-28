// The interface every file in this folder implements: one file per language, listed once in
// index.ts. A language group adds or changes its own file and nothing shared. The checklist for a
// new one is "Adding a language" in support/README.md; tests/languages.test.ts enforces it.
//
// A language file may import only `../util.ts`, `../patterns.ts`, its siblings in this folder, and
// types. Anything else (profile, contract, replay) imports the registry, so importing it back would
// be a cycle.
import type { Site } from "../mutate.ts";
import type { CiCommand } from "../plan/ci.ts";
import type { Rubric } from "../rubric.ts";
import type { Stack } from "../support.ts";
import type { CommandKind, Component, ContractCommand, Language, PackageManager, Profile } from "../types.ts";

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
  // A project at the root next to a root package.json, listed with its own share of changes. `match`
  // finds a manifest whose name varies, such as a solution file.
  rootApp?: { names: string[]; match?: RegExp; stack: string; toolchain: string; suffix: string; rank: number };
  // The test commands of this language's build tool, so a package.json whose test script only hands
  // over to them, such as `"test": "cargo test"` next to Cargo.toml, wraps a project of this language.
  runners?: RegExp;
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
  // A manifest of this language nested in another project of it (`parent`, tree-relative) that is a
  // project of its own rather than part of the enclosing build, such as a nested go.mod, which Go
  // builds and tests apart. Without it, the enclosing project owns every folder under it, as a Maven
  // reactor owns its modules.
  ownUnit?(tree: string, parent: string, dir: string): boolean;
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
  // Exits 0 when the image already has it; `command -v <tool>` when unset.
  present?: string;
}

// A toolchain another of the audit's pinned images ships, copied into a component's container next
// to the image's own with the network on, before the install: a second JDK a Gradle toolchain asks
// for. Nothing is downloaded once the network is off, so the build finds it offline.
export interface ToolchainCopy {
  // As the report names it, such as "JDK 17".
  spec: string;
  // The pinned image it comes from, a key of `images`.
  image: string;
  // The folder in that image, and where it goes in the component's container.
  from: string;
  to: string;
  // Why the build needs it, as the report says it after "because".
  reason: string;
  // Points the build tool at every copy, run as the image's user once they are in. `home` is the
  // home every command shares. One command for all of a language's copies, so it may run once.
  register(home: string): string;
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
  // For each file, the test files that reach it, so a run with a fault in it can be narrowed to
  // them; null for a file no narrowed run can be trusted for. Omitted: every run is the whole suite.
  reaching?(tree: string, comp: Component, tests: string[]): (file: string) => string[] | null;
  // How to tell a planted fault compiles, run before the tests. A fault that doesn't compile is
  // discarded, never counted as caught. `contract` is the audit's commands and `root` the folder
  // the replay runs in.
  compileProbe(comp: Component, ctx: { contract: ContractCommand[]; root: string }): { command: string; cwd: string } | null;
  // Whether a probe's or test run's output says the code doesn't compile, such as Go's
  // "undefined: x". Omitted: diagnose.ts decides, which knows TypeScript's and Python's errors.
  compileError?(output: string): boolean;
}

// How the replay runs a component of this language in an image of its own, installed in its own
// folder. A language with a supported stack has these or `sharedRoot`, never both.
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
  // Toolchains the build needs beside the image's own, copied in from other pinned images.
  toolchains?(tree: string, dir: string): ToolchainCopy[];
  budget?: ToolchainBudget;
}

// What contract.ts lends a language's hooks, which can't import it back.
export interface ContractContext {
  profile: Profile;
  rubric: Rubric;
  // The rubric's command limit.
  timeoutSec: number;
  // The run steps of the repo's GitHub Actions workflows, read once.
  ci(): CiCommand[];
  // The test script CI runs in a folder (plan/ci.ts), with workspace-delegating steps left out.
  ciTestScript(path: string, scripts: Record<string, string>): { script: string; called: string; source: string } | null;
  // The variables CI sets for the step that runs a script (plan/ci.ts).
  ciEnvFor(path: string, script: string | null, source: string): Record<string, string>;
  // The package.json script a command runs, such as `test` for `pnpm test` (plan/ci.ts).
  scriptCalled(command: string): string | null;
  // The same lint or type-check with its write flags removed (contract.ts).
  checkOnly(cmd: ContractCommand, scripts: Record<string, string>, pm: string | null): ContractCommand;
  // The Make target that runs the tests, and its line.
  makeTestTarget(text: string | null): { target: string; line: number } | null;
}

// How the contract runs a language whose components share the repo root's install and image unless
// they commit a lockfile of their own, as Node and Python projects do. Its hooks answer for every
// component of the language in an image at once; contract.ts orders what they give.
export interface SharedRootHooks {
  // The repo's image, when the profile makes it this language's; null leaves it to the next. The
  // language marked `fallback` is asked last and always answers. `standalone` is every component of
  // a shared-root language with a package manager of its own below the root.
  repoImage(tree: string, profile: Profile, standalone: Component[]): string | null;
  // A component's own image, for one with its own package manager that can't run in the repo's.
  ownImage(tree: string, comp: Component, repoImage: string): string | null;
  // The toolchain checks an image needs for the package managers its components use.
  doctor(pms: Set<PackageManager>, comps: Component[]): string[];
  // Tools a frozen install needs that the image doesn't ship, by package manager and the folder
  // that pins its version. `home` is the home every command shares.
  setup(tree: string, pms: Map<PackageManager, string>, home: string): ToolSetup[];
  // The component's build, lint, type-check and test commands, in that order.
  commands(tree: string, comp: Component, ctx: ContractContext): ContractCommand[];
  // From 2026-12-beta: the literal variables CI sets for the step that runs the component's tests,
  // which every command of the component then runs with. Omitted: none.
  testEnv?(comp: Component, test: ContractCommand, ctx: ContractContext): Record<string, string>;
  // A test command for a component below the root with none of its own: the root's run, scoped to
  // its folder. Omitted: none.
  scopedTest?(tree: string, comp: Component, ctx: ContractContext): ContractCommand | null;
  // Setup an image of another language needs before this language's components run in it, such as
  // the venv module Python needs in the Node image. Omitted: none.
  foreignImage?(image: string): { command: string; added: string; failed: string } | null;
  // Only the language whose image is the repo's when nothing else decides: the doctor of an image
  // whose components name no package manager.
  fallback?: { doctor: string };
}

// A manifest's named scripts, which the safety scan reads for sudo, network pipes, deletes and
// deploys, and for the ones every install runs.
export interface ManifestScripts {
  // Whether a manifest the scan found (tree-relative) is one of this language's.
  manifest(path: string): boolean;
  // The scripts by name, or null when the manifest can't be read.
  read(tree: string, manifest: string): Record<string, string> | null;
  // Script names the package manager runs on every install, such as npm's postinstall.
  installHook: RegExp;
}

// The rules the language-neutral checks read for one language. Every key must be given; null says
// this language has no rule for that check, and a report says "not checked for <label>" rather
// than an all-clear (notCheckedFor in index.ts).
export interface LanguageChecks {
  // `readiness diff`: which paths are test files, and which added lines are skip markers or test
  // cases. A language with fault hooks uses their `isTest`.
  weakening: {
    isTest: ((path: string) => boolean) | null;
    markers: { skip: RegExp; testCase: RegExp } | null;
  };
  lockfiles: {
    // Lockfile names whose changes `readiness diff` lists.
    diff: string[] | null;
    // Generated lockfiles the secret scan skips: they are full of hashes that look like keys.
    secretScanSkips: string[];
    // For each package manager, the lockfile a pull request adds when it starts using that manager
    // in a repo that uses another: outcomes and the roadmap watch for it.
    foreign: Partial<Record<PackageManager, string>> | null;
  };
  // Install hooks, sudo, network pipes and deploys in a manifest's scripts.
  manifestScripts: ManifestScripts | null;
  // The first program of a command line that marks it as this language's, so a replayed
  // instruction runs in the image of a component of this language.
  tool: RegExp | null;
  // The files that show the run plan a component has tests at all (plan/test-files.ts). A language
  // with fault hooks uses their `isTest`.
  countedTests: ((path: string) => boolean) | null;
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
  checks: LanguageChecks;
  // Where faults may be planted and how a planted one is run; null when faults aren't planted in
  // this language.
  mutation: MutationHooks | null;
  replay?: ReplayHooks;
  sharedRoot?: SharedRootHooks;
}
