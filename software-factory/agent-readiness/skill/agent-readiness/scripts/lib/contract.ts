import { isAbsolute, join, normalize } from "node:path";
import { DEFAULT_NODE, NODE_MAJORS } from "./images.ts";
import { ecosystemOf, languageOf } from "./languages/index.ts";
import type { ToolchainCopy, ToolSetup } from "./languages/language.ts";
import { POETRY_ENV, VENV, poetryVersion, pyproject, testGroups, toxRuns } from "./languages/python.ts";
import type { Rubric } from "./rubric.ts";
import { readPackageJson } from "./languages/node.ts";
import type { CommandKind, Component, ContractCommand, Profile, SafetyFinding } from "./types.ts";
import { exists, fail, listFiles, readText, shellQuote } from "./util.ts";

export { POETRY_ENV, VENV, poetryVersion, testGroups };
export type { ToolchainCopy, ToolSetup };

const PLACEHOLDER_TEST = /no test specified/;

const SCRIPT_ALIASES: Record<"build" | "lint" | "typecheck" | "test", string[]> = {
  build: ["build"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "check-types", "tsc"],
  test: ["test"],
};

// The ecosystem's frozen install, from its language file.
function frozenInstall(pm: Profile["packageManager"], tree: string, path: string, ignoreScripts: boolean): { command: string; reason: string } {
  return ecosystemOf(pm)?.install(tree, path, { ignoreScripts }) ?? { command: "true", reason: "no package manager found" };
}

const nodeLang = (c: Component) => c.language === "ts" || c.language === "js";

// A component a language file's replay hooks install, build and test, rather than contract.ts.
export function hooked(c: Component) {
  return languageOf(c.language)?.replay;
}

function runScript(pm: string | null, script: string): string {
  if (pm === "pnpm") return `corepack pnpm run ${script}`;
  if (pm === "yarn") return `corepack yarn run ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

// uv sync and Poetry install into .venv; a uv workspace has one, at its root.
function pythonTest(tree: string, path: string, pm: Profile["packageManager"], workspaceMember: boolean): string | null {
  const dir = join(tree, path);
  const up = workspaceMember ? path.split("/").map(() => "..").join("/") + "/" : "";
  const python = pm === "uv" || pm === "poetry" ? `${up}.venv/bin/python` : `${VENV}/bin/python`;
  // A workspace member runs the root's pytest when the root declares it.
  const dirs = workspaceMember ? [dir, tree] : [dir];
  const reqs = dirs.flatMap((d) => ["requirements.txt", "requirements-dev.txt", "pyproject.toml"].map((f) => (exists(join(d, f)) ? readText(join(d, f)) : ""))).join("\n");
  if (/pytest/.test(reqs) || dirs.some((d) => exists(join(d, "pytest.ini")) || exists(join(d, "conftest.py")))) return `${python} -m pytest -q`;
  if (pm === "pip" && toxRuns(dir)) return `${python} -m tox`;
  if (exists(join(dir, "tests"))) return `${python} -m unittest discover -s tests -t .`;
  return null;
}

// The toolchains a set of Node and Python components use; a hooked component's language file
// gives its own.
function doctorCommand(profile: Profile, comps: Component[]): string {
  const pms = new Set(comps.map((c) => c.packageManager ?? profile.packageManager).filter((x): x is NonNullable<Profile["packageManager"]> => Boolean(x)));
  const parts: string[] = [];
  if ([...pms].some((p) => p === "npm" || p === "pnpm" || p === "yarn")) parts.push("node --version");
  if (pms.has("bun")) parts.push("bun --version");
  if (pms.has("npm")) parts.push("npm --version");
  if (pms.has("pnpm")) parts.push("corepack pnpm --version");
  if (pms.has("yarn")) parts.push("corepack yarn --version");
  if (pms.has("pip") || pms.has("uv") || pms.has("poetry") || comps.some((c) => c.language === "py")) parts.push("python3 --version");
  if (pms.has("uv")) parts.push("uv --version");
  if (pms.has("poetry")) parts.push("poetry --version");
  for (const c of comps) {
    const doctor = hooked(c)?.doctor;
    if (doctor && !parts.includes(doctor)) parts.push(doctor);
  }
  return parts.length ? parts.join(" && ") : "node --version";
}

// The script a command runs, so `pnpm test` and `corepack pnpm run test` count as one command.
function scriptOf(command: string): string | null {
  const m = command.trim().replace(/^corepack\s+/, "").match(/^(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)(\s|$)/);
  if (!m) return null;
  return ["install", "ci", "add", "exec", "dlx", "x"].includes(m[2]) ? null : m[2];
}

// Lint and format commands that rewrite files when asked to: `biome check --write`, `eslint --fix`,
// `prettier --write`, `ruff format`. A check has to leave the code as it found it, or it rewrites
// the copy that faults are planted in and passes because it fixed what it should have reported.
const WRITE_FLAG = /^(--fix|--write|--unsafe-fixes|--apply|--apply-unsafe|--fix-type(=.*)?)$/;
const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
const LAUNCHER_PAIRS = /^(pnpm|yarn|npm|bun) (exec|dlx|x)$|^(uv|poetry|pdm|hatch|pipenv) run$|^python3? -m$/;
const SEPARATOR = /(\s*(?:&&|\|\||;|\|)\s*)/;
const MAX_SCRIPT_DEPTH = 4;

export interface CheckOnly {
  command: string;
  // What changed, for the reason: "without --write", "ruff format with --check".
  changes: string[];
}

function toolAt(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_]\w*=/.test(words[i]) || LAUNCHERS.has(words[i])) i++;
    else if (i + 1 < words.length && LAUNCHER_PAIRS.test(`${words[i]} ${words[i + 1]}`)) i += 2;
    else if (i > 0 && (words[i].startsWith("-") || words[i] === "--")) i++;
    else break;
  }
  return i;
}

function toolName(word: string | undefined): string {
  return (word ?? "").replace(/^@biomejs\//, "").split("/").pop()!.replace(/@[^@]*$/, "");
}

// One command with its write flags removed, or switched to the tool's check mode.
function checkOnlySegment(segment: string, changes: string[]): string {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const at = toolAt(words);
  const tool = toolName(words[at]);
  const has = (...flags: string[]) => words.some((w) => flags.includes(w));
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i <= at) {
      out.push(w);
      continue;
    }
    if (WRITE_FLAG.test(w) || (tool === "biome" && w === "--unsafe") || (tool === "prettier" && w === "-w")) {
      if (tool === "prettier" && !has("--check", "-c", "--list-different", "-l") && !out.includes("--check")) {
        out.push("--check");
        changes.push("prettier with --check");
      }
      changes.push(`without ${w}`);
      if (w === "--fix-type") i++;
      continue;
    }
    out.push(w);
  }
  const sub = out[at + 1];
  const insert = (flag: string, after: number) => {
    if (has("--version", "-V", "--help", "-h")) return;
    out.splice(after + 1, 0, flag);
    changes.push(`${words.slice(at, after + 1).join(" ")} with ${flag}`);
  };
  const rename = (to: string) => {
    changes.push(`${tool} ${to} instead of ${tool} ${sub}`);
    out[at + 1] = to;
  };
  if (tool === "ruff" && sub === "format" && !has("--check", "--diff")) insert("--check", at + 1);
  if (tool === "black" && !has("--check", "--diff")) insert("--check", at);
  if (tool === "isort" && !has("--check", "--check-only", "-c", "--diff")) insert("--check-only", at);
  if (tool === "dprint" && sub === "fmt") rename("check");
  if (tool === "sqlfluff" && sub === "fix") rename("lint");
  return out.join(" ");
}

// Inlines calls to the package's own scripts, so a flag behind `npm run lint:fix` is seen too.
function expandScripts(body: string, scripts: Record<string, string>, depth: number): string {
  if (depth > MAX_SCRIPT_DEPTH) return body;
  const parts = body.split(SEPARATOR);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const script = scriptOf(part);
      if (!script || !(script in scripts)) return part;
      const rest = part.trim().replace(/^corepack\s+/, "").split(/\s+/);
      const extra = rest.slice(rest.indexOf(script) + 1).filter((w, j) => !(j === 0 && w === "--"));
      const inner = expandScripts([scripts[script], ...extra].join(" "), scripts, depth + 1);
      return parts.length > 1 && SEPARATOR.test(inner) ? `(${inner})` : inner;
    })
    .join("");
}

function execIn(pm: string | null, body: string): string {
  const quoted = `'${body.replace(/'/g, `'\\''`)}'`;
  if (pm === "pnpm") return `corepack pnpm exec sh -c ${quoted}`;
  if (pm === "yarn") return `corepack yarn exec sh -c ${quoted}`;
  return `npm exec -c ${quoted}`;
}

// The same check with every write flag removed. A script call is inlined and run with the
// package's binaries on PATH, as `npm run` would; anything else is rewritten in place. The command
// comes back unchanged when nothing in it writes.
export function checkOnly(command: string, scripts: Record<string, string>, pm: string | null): CheckOnly {
  const changes: string[] = [];
  const viaScript = scriptOf(command) !== null;
  const body = viaScript ? expandScripts(command, scripts, 0) : command;
  const rewritten = body
    .split(SEPARATOR)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/^(\s*\(*)(.*?)(\)*\s*)$/, (_m, open: string, inner: string, close: string) => open + checkOnlySegment(inner, changes) + close)))
    .join("");
  if (changes.length === 0) return { command, changes };
  return { command: viaScript ? execIn(pm, rewritten) : rewritten, changes: [...new Set(changes)] };
}

export function checkOnlyCommand(cmd: ContractCommand, scripts: Record<string, string>, pm: string | null): ContractCommand {
  if (cmd.kind !== "lint" && cmd.kind !== "typecheck") return cmd;
  const safe = checkOnly(cmd.command, scripts, pm);
  if (safe.changes.length === 0) return cmd;
  return { ...cmd, command: safe.command, declared: cmd.command, reason: `${cmd.reason}; run check-only (${safe.changes.join(", ")}) so it can't rewrite the code` };
}

export function hasNetworkPipedHook(findings: SafetyFinding[]): boolean {
  return findings.some((f) => f.kind === "network_piped" && f.file.endsWith("package.json"));
}

export function discoverContract(profile: Profile, tree: string, rubric: Rubric, safety: SafetyFinding[]): ContractCommand[] {
  const cmds: ContractCommand[] = [];
  const timeout = rubric.budgets.commandTimeoutSec;
  const pm = profile.packageManager;
  const assessed = profile.components.filter((c) => c.assessed);
  if (assessed.length === 0) return cmds;
  // One doctor per image: the repo's image proves the toolchains of the components that run in it,
  // and each other image proves its own component's.
  const plan = imagePlan(profile, tree);
  const inRepoImage = assessed.filter((c) => plan[0].components.includes(c.id));
  if (inRepoImage.length) cmds.push({ id: "cmd-repo-doctor", kind: "doctor", component: "*", cwd: ".", command: doctorCommand(profile, inRepoImage), source: "readiness", reason: "the toolchains the assessed components use are present", timeoutSec: 60 });
  for (const g of plan.slice(1)) {
    for (const c of assessed.filter((x) => g.components.includes(x.id))) cmds.push({ id: `cmd-${c.id}-doctor`, kind: "doctor", component: c.id, cwd: ".", command: doctorCommand(profile, [c]), source: "readiness", reason: `the toolchain ${c.id} uses is present in ${g.image}`, timeoutSec: 60 });
  }
  const ignoreScripts = hasNetworkPipedHook(safety);
  const hookNote = ignoreScripts ? "; install hooks skipped because one pipes the network into a shell" : "";
  const own = assessed.filter((c) => hooked(c));
  const standalone = assessed.filter((c) => !hooked(c) && c.packageManager && c.path !== ".");
  const declared = profile.environmentJson?.install;
  if (declared) cmds.push({ id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: declared, source: ".cursor/environment.json install", reason: "the repo's declared install", timeoutSec: timeout });
  // Behind a declared install, the frozen installs run only if this machine blocks it, so one
  // component's missing toolchain doesn't keep the others from being checked.
  const fallbackFor = declared ? "cmd-repo-install" : undefined;
  if (pm || (!declared && standalone.length === 0 && own.length === 0)) {
    const install = frozenInstall(pm, tree, ".", ignoreScripts);
    cmds.push({ id: declared ? "cmd-repo-frozen-install" : "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: install.command, source: "readiness", reason: install.reason + hookNote, timeoutSec: timeout, ...(fallbackFor ? { fallbackFor } : {}) });
  }
  for (const c of standalone) {
    const install = frozenInstall(c.packageManager ?? null, tree, c.path, ignoreScripts);
    cmds.push({ id: `cmd-${c.id}-install`, kind: "install", component: c.id, cwd: c.path, command: install.command, source: "readiness", reason: `${install.reason} in ${c.path}${hookNote}`, timeoutSec: timeout, ...(fallbackFor ? { fallbackFor } : {}) });
  }
  for (const c of own) {
    const install = frozenInstall(c.packageManager ?? null, tree, c.path, ignoreScripts);
    const where = c.path === "." ? "" : ` in ${c.path}`;
    cmds.push({ id: `cmd-${c.id}-install`, kind: "install", component: c.id, cwd: c.path, command: install.command, source: "readiness", reason: `${install.reason}${where}`, timeoutSec: commandTimeout(rubric, c), ...(fallbackFor ? { fallbackFor } : {}) });
  }
  if (profile.environmentJson?.start) {
    cmds.push({ id: "cmd-repo-start", kind: "start", component: "*", cwd: ".", command: profile.environmentJson.start, source: ".cursor/environment.json start", reason: "the repo's declared services", timeoutSec: 180 });
  }
  for (const c of own) {
    for (const d of hooked(c)!.commands(tree, c)) {
      const cwd = d.cwd && d.cwd !== "." ? (c.path === "." ? d.cwd : `${c.path}/${d.cwd}`) : c.path;
      cmds.push(checkOnlyCommand({ id: `cmd-${c.id}-${d.kind}`, kind: d.kind, component: c.id, cwd, command: d.command, source: d.source, reason: d.reason, timeoutSec: commandTimeout(rubric, c) }, {}, null));
    }
  }
  for (const c of assessed.filter((x) => !hooked(x))) {
    if (c.language === "py") {
      const test = pythonTest(tree, c.path, c.packageManager ?? pm, c.stack === "uv-workspace" && c.path !== "." && !c.packageManager);
      if (test) cmds.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.path, command: test, source: c.manifest ?? "readiness", reason: "discovered test runner", timeoutSec: timeout });
      continue;
    }
    for (const kind of ["build", "lint", "typecheck", "test"] as const) {
      const script = SCRIPT_ALIASES[kind].find((s) => c.scripts[s] && !(kind === "test" && PLACEHOLDER_TEST.test(c.scripts[s])));
      if (!script) continue;
      const cmd: ContractCommand = { id: `cmd-${c.id}-${kind}`, kind, component: c.id, cwd: c.path, command: runScript(c.packageManager ?? pm, script), source: `${c.manifest} scripts.${script}`, reason: `discovered ${kind} script`, timeoutSec: timeout };
      cmds.push(checkOnlyCommand(cmd, c.scripts, c.packageManager ?? pm));
    }
    // No test script, but a Make target that runs the tests, such as `make test` calling a test:unit
    // script: the repo's own entry point is the test command.
    if (!cmds.some((k) => k.component === c.id && k.kind === "test")) {
      const makefile = c.path === "." ? "Makefile" : `${c.path}/Makefile`;
      const make = makeTestTarget(exists(join(tree, makefile)) ? readText(join(tree, makefile)) : null);
      if (make) cmds.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.path, command: `make ${make.target}`, source: `${makefile}:${make.line}`, reason: `the Makefile's ${make.target} target runs the tests`, timeoutSec: timeout });
    }
  }
  // A workspace whose tests run from the root (`"test": "vitest"`) has packages with no test script
  // of their own. Each package that has test files gets the root run scoped to its folder, so it is
  // credited with its own tests and one failing package doesn't fail the others.
  const root = rootTestRunner(tree);
  if (root) {
    for (const c of assessed.filter((x) => nodeLang(x) && x.path !== "." && !cmds.some((k) => k.component === x.id && k.kind === "test"))) {
      if (!hasTestFiles(join(tree, c.path))) continue;
      cmds.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: ".", command: scopedRun(pm, root.script, c.path), source: `package.json scripts.${root.script}`, reason: `the root ${root.runner} run, scoped to ${c.path}`, timeoutSec: timeout });
    }
  }
  return cmds;
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

// Replay runs only commands for "*" and assessed components, so anything else would be dropped silently.
export function checkComponent(profile: Profile | null, component: string): void {
  if (!profile) fail("Run `readiness scan` first: commands are added to the components it found.");
  if (component === "*") return;
  const c = profile.components.find((x) => x.id === component);
  const assessed = profile.components.filter((x) => x.assessed).map((x) => x.id);
  const choices = `Use * for a repo-wide command${assessed.length ? ` or one of: ${assessed.join(", ")}` : ""}.`;
  if (!c) fail(`No component named ${component}. ${choices}`);
  if (!c.assessed) fail(`${component} isn't assessed (${c.notAssessedReason ?? "not supported"}), so replay wouldn't run its commands. ${choices}`);
}

// Reads a file as it is in the audited commit, or null when the commit doesn't have it.
export type CommitReader = (path: string) => string | null;

function escapes(path: string): boolean {
  return isAbsolute(path) || normalize(path).split(/[\\/]/).includes("..");
}

// Explicit targets and pattern rules such as `test-%`, but not `VAR := value`.
export function makeTargets(text: string | null): string[] {
  return text ? [...text.matchAll(/^([\w.%-]+)\s*:(?!=)/gm)].map((m) => m[1]) : [];
}

const TEST_RUN = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test[\w:.-]*|\b(pytest|vitest|jest|mocha|tox|nox|phpunit|rspec)\b|\b(go|cargo|dotnet|mix)\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/;
const MAKE_CALL = /(?:\$\(MAKE\)|\$\{MAKE\}|\bmake)\s+(?:-\S+\s+)*([\w.-]+)/g;

// The Make target that runs the tests, as `make test` does when its recipe, or a target it depends on
// or calls with $(MAKE), runs a test runner. With the line of the target, for the contract's source.
export function makeTestTarget(text: string | null): { target: string; line: number } | null {
  if (!text) return null;
  const lines = text.split("\n");
  const rules = new Map<string, { line: number; deps: string[]; recipe: string[] }>();
  let current: { line: number; deps: string[]; recipe: string[] } | null = null;
  lines.forEach((l, i) => {
    const head = l.match(/^([\w.-]+(?:\s+[\w.-]+)*)\s*:(?!=)(.*)$/);
    if (head) {
      current = { line: i + 1, deps: head[2].replace(/[|;].*$/, "").trim().split(/\s+/).filter(Boolean), recipe: head[2].includes(";") ? [head[2].split(";").slice(1).join(";")] : [] };
      for (const t of head[1].split(/\s+/)) if (!rules.has(t)) rules.set(t, current);
    } else if (current && l.startsWith("\t")) current.recipe.push(l.trim().replace(/^[@+-]+/, ""));
    else if (l.trim() && !l.startsWith("#")) current = null;
  });
  const runs = (target: string, seen: Set<string>): boolean => {
    const rule = rules.get(target);
    if (!rule || seen.has(target)) return false;
    seen.add(target);
    if (rule.recipe.some((r) => TEST_RUN.test(r))) return true;
    const called = rule.recipe.flatMap((r) => [...r.matchAll(MAKE_CALL)].map((m) => m[1]));
    return [...rule.deps, ...called].some((t) => runs(t, seen));
  };
  for (const target of ["test", "tests", "check"]) if (runs(target, new Set())) return { target, line: rules.get(target)!.line };
  return null;
}

// Whether `make name` has a rule: a target of that name, or a pattern rule whose % matches a non-empty stem.
export function makeRuleFor(targets: string[], name: string): string | undefined {
  return targets.find((t) => t === name) ?? targets.find((t) => t.includes("%") && new RegExp(`^${t.split("%", 2).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`).test(name));
}

// Commands that pass whatever the repo does, so they can never stand in for a check.
const TRIVIAL = /^\s*(true|:|\/bin\/true|exit(\s+0)?|echo\b.*|printf\b.*|sleep\s+\d+|test\s+\S+|\[[^\]]*\])\s*$/;
const CHAINED = /\|\||&&|;|\||`|\$\(|\n/;

// The commands the cited line writes: in a code span, after a CI `run:`, or the whole line, each
// split at && and ; with a leading `cd <dir>` dropped.
function commandsOn(line: string): string[] {
  const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const run = line.match(/^\s*-?\s*run:\s*(.+)$/)?.[1]?.trim();
  // A manifest's script entry, such as `"test": "node --test test/",` in package.json.
  const entry = line.match(/^\s*"[\w:.-]+"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/)?.[1];
  const script = entry ? (JSON.parse(entry) as string).trim() : null;
  const whole = [...spans, ...(run ? [run] : []), ...(script ? [script] : []), line.trim().replace(/^[-*]\s+/, "").replace(/^\$\s+/, "")];
  return [...whole, ...whole.flatMap((c) => c.split(/\s*(?:&&|;)\s*/)).filter((c) => !/^cd\s/.test(c))].map((c) => c.trim()).filter(Boolean);
}

// A bare script call, with nothing after the script name that could change what it checks.
const BARE_SCRIPT = /^(corepack\s+)?(npm|pnpm|yarn|bun)\s+(run(-script)?\s+)?[\w:.-]+$/;

// The repo has to define a command before it joins the contract: the cited line of the audited
// commit names it, or it runs a manifest script or Make target. Otherwise anything, even `true`,
// could stand in for the tests.
function checkSource(read: CommitReader, profile: Profile, input: { component: string; cwd: string; command: string; source: string }): void {
  const command = input.command.trim();
  if (TRIVIAL.test(command)) fail(`\`${command}\` passes whatever the repo does, so it can't be a check.`);
  if (/\|\|\s*(true|:|exit(\s+0)?)\s*$/.test(command)) fail(`\`${command}\` hides its own failure, so it can't be a check.`);
  const script = scriptOf(command);
  const cited = input.source.match(/^(.+):(\d+)$/);
  if (cited) {
    if (escapes(cited[1])) fail(`--source ${input.source} points outside the repository.`);
    const text = read(cited[1]);
    if (text === null) fail(`--source ${input.source}: ${cited[1]} isn't in the audited commit.`);
    const line = text.split("\n")[Number(cited[2]) - 1] ?? "";
    const on = commandsOn(line);
    // Exactly what the line says, or the same bare script call: extra arguments or a pipe could
    // turn the check into one that always passes.
    const exact = on.includes(command);
    if (!exact && CHAINED.test(command)) fail(`\`${command}\` chains commands; add each one the repo defines on its own, citing where with --source file:line.`);
    const named = exact || (script !== null && BARE_SCRIPT.test(command) && on.some((c) => scriptOf(c) === script));
    if (!named) fail(`--source ${input.source} doesn't name \`${command}\`. Cite the line where the repo documents or runs it.`);
    return;
  }
  if (CHAINED.test(command)) fail(`\`${command}\` chains commands; add each one the repo defines on its own, citing where with --source file:line.`);
  if (script && !BARE_SCRIPT.test(command)) fail(`\`${command}\` passes extra arguments to the ${script} script; add the script as the repo defines it.`);
  const comp = profile.components.find((c) => c.id === input.component);
  const make = command.match(/^make\s+([\w.-]+)$/);
  if (script && (comp?.scripts[script] || profile.components.some((c) => c.path === input.cwd && c.scripts[script]))) return;
  if (make && makeRuleFor(makeTargets(read(join(input.cwd, "Makefile"))), make[1])) return;
  fail(`\`${command}\` doesn't run a script or Make target the repo defines. Add only commands the repo defines, and cite where with --source file:line.`);
}

export const COMMAND_KINDS: CommandKind[] = ["doctor", "install", "build", "lint", "typecheck", "test", "start"];
const KIND_ALIASES: Record<string, CommandKind> = { "type-check": "typecheck", type_check: "typecheck", types: "typecheck", tsc: "typecheck", tests: "test" };

// The kind as the contract stores it. Spellings people use for a type-check are accepted; anything
// else is refused, since an unknown kind would never map to a check and be dropped from the replay.
export function commandKind(kind: string): CommandKind {
  const k = kind.trim().toLowerCase();
  if ((COMMAND_KINDS as string[]).includes(k)) return k as CommandKind;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  return fail(`--kind ${kind} isn't a kind the audit runs. Use one of: ${COMMAND_KINDS.join(", ")}.`);
}

export function addContractCommand(cmds: ContractCommand[], rawInput: { kind: CommandKind | string; component: string; cwd: string; command: string; source: string; reason: string; timeoutSec?: number }, profile: Profile | null, read?: CommitReader): ContractCommand {
  const input = { ...rawInput, kind: commandKind(rawInput.kind) };
  checkComponent(profile, input.component);
  if (!input.reason.trim()) fail("contract add needs --reason");
  // From the CLI a command is the agent's (`agent`) or the repo's (`file:line`); the scan's own
  // sources aren't for the agent to claim.
  const sources = read ? /^(agent|[^:\s]+:\d+)$/ : /^(agent|[^:]+:\d+|readiness|[^\s]+ scripts\.[\w:-]+)$/;
  if (!sources.test(input.source)) fail("--source must be `agent` or a file:line where the command was found");
  if (escapes(input.cwd)) fail(`--cwd ${input.cwd} points outside the repository, which the audit refuses.`);
  const citedFile = input.source.match(/^(.+):\d+$/)?.[1];
  if (citedFile && escapes(citedFile)) fail(`--source ${input.source} points outside the repository.`);
  const dir = (d: string) => d.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const script = scriptOf(input.command);
  const same = cmds.find((c) => c.component === input.component && dir(c.cwd) === dir(input.cwd) && (c.command.trim() === input.command.trim() || (script !== null && scriptOf(c.command) === script)));
  if (same) fail(`${same.id} already runs ${script ? `the ${script} script` : "this command"} for ${input.component === "*" ? "the repo" : input.component} (\`${same.command}\`), so it would run twice. Leave it out of the contract.`);
  if (read && profile) checkSource(read, profile, input);
  const base = `cmd-${input.component === "*" ? "repo" : input.component}-${input.kind}`;
  let id = base;
  let i = 2;
  while (cmds.some((c) => c.id === id)) id = `${base}-${i++}`;
  const comp = profile?.components.find((c) => c.id === input.component) ?? profile?.components.find((c) => dir(c.path) === dir(input.cwd));
  const cmd = checkOnlyCommand({ id, timeoutSec: input.timeoutSec ?? 600, ...input }, comp?.scripts ?? {}, comp?.packageManager ?? profile?.packageManager ?? null);
  cmds.push(cmd);
  return cmd;
}

// The package managers of the assessed components, each with the folder that pins its version.
function assessedManagers(profile: Profile, only?: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of profile.components.filter((x) => x.assessed && !hooked(x) && (!only || only.has(x.id)))) {
    const pm = c.packageManager ?? profile.packageManager;
    if (pm && !out.has(pm)) out.set(pm, c.packageManager && c.path !== "." ? c.path : ".");
  }
  return out;
}

// Tools a frozen install needs that the audit's base images don't ship: Bun in the Node image and
// Poetry in the Python one, and whatever a language file's setup adds. Each goes in at the version
// the repo pins, as the image's own user and with the network on, before the install runs. Without
// it the install is blocked, not failed. `only` limits it to the components one image runs.
export function toolSetup(profile: Profile, tree: string, only?: Set<string>): ToolSetup[] {
  const pms = assessedManagers(profile, only);
  const out: ToolSetup[] = [];
  const bunDir = pms.get("bun");
  if (bunDir !== undefined) {
    const pkg = readPackageJson(join(tree, bunDir));
    const pin = pkg?.packageManager?.match(/^bun@(\d[\w.+-]*)/)?.[1] ?? pkg?.engines?.bun;
    const spec = `bun@${pin ?? "1"}`;
    out.push({ tool: "bun", spec, install: `npm install -g --silent --no-fund --no-audit ${shellQuote(spec)}` });
  }
  const poetryDir = pms.get("poetry");
  if (poetryDir !== undefined) {
    const version = poetryVersion(join(tree, poetryDir));
    const spec = version ? `poetry==${version}` : "poetry";
    const venv = "/opt/readiness-poetry";
    out.push({ tool: "poetry", spec, install: `python3 -m venv ${venv} && ${venv}/bin/pip install -q --disable-pip-version-check ${shellQuote(spec)} && ln -sf ${venv}/bin/poetry /usr/local/bin/poetry` });
  }
  for (const c of profile.components.filter((x) => x.assessed && (!only || only.has(x.id)))) {
    for (const t of hooked(c)?.setup?.(tree, c.path) ?? []) if (!out.some((o) => o.spec === t.spec)) out.push(t);
  }
  return out;
}

// Toolchains the components one image runs need beside the image's own, such as a second JDK, each
// copied in once from its own pinned image.
export function toolchainCopies(profile: Profile, tree: string, only?: Set<string>): ToolchainCopy[] {
  const out: ToolchainCopy[] = [];
  for (const c of profile.components.filter((x) => x.assessed && (!only || only.has(x.id)))) {
    for (const t of hooked(c)?.toolchains?.(tree, c.path) ?? []) if (!out.some((o) => o.to === t.to)) out.push(t);
  }
  return out;
}

// A command's limit: the rubric's, or the floor a slow toolchain's language file raises it to.
export function commandTimeout(rubric: Rubric, c: Component): number {
  return Math.max(rubric.budgets.commandTimeoutSec, hooked(c)?.budget?.commandTimeoutSec ?? 0);
}

const DEFAULT_PYTHON = "3.12";

// The lowest Python a project's requires-python, or Poetry's python dependency, allows.
export function requiredPython(dir: string): string | null {
  const text = pyproject(dir);
  const poetry = text.match(/^\[tool\.poetry\.dependencies\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  const spec = text.match(/^requires-python\s*=\s*["']([^"']+)["']/m)?.[1] ?? poetry.match(/^python\s*=\s*["']([^"']+)["']/m)?.[1];
  const m = spec?.match(/(?:>=|\^|~=|==|~)\s*(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];
};

// The default Python, or a newer one when a project needs it, so the image satisfies requires-python.
function pythonFor(dirs: string[]): string {
  return dirs.map(requiredPython).filter((v): v is string => v !== null).reduce((best, v) => (newer(v, best) ? v : best), DEFAULT_PYTHON);
}

function pythonImage(tree: string, dir: string, pm: Profile["packageManager"]): string {
  const file = [dir, "."].map((d) => join(tree, d, ".python-version")).find(exists);
  const pv = file ? readText(file).trim().match(/^(\d+\.\d+)/)?.[1] : null;
  const version = pv ?? pythonFor([join(tree, dir)]);
  return pm === "uv" ? `ghcr.io/astral-sh/uv:python${version}-bookworm-slim` : `python:${version}-slim`;
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

const PY_MANAGERS = new Set<Profile["packageManager"]>(["pip", "uv", "poetry"]);

// The repo's image: the one the repo-wide commands, and the Node and Python components that share
// the root's toolchain, run in.
export function containerImage(profile: Profile, tree: string): string {
  if (PY_MANAGERS.has(profile.packageManager)) return pythonImage(tree, ".", profile.packageManager);
  const standalone = profile.components.filter((c) => c.packageManager && c.path !== "." && !hooked(c));
  if (!profile.packageManager && standalone.length > 0 && standalone.every((c) => c.language === "py")) return `python:${pythonFor(standalone.map((c) => join(tree, c.path)))}-slim`;
  return nodeImage(tree, [".", ...standalone.filter((c) => c.language !== "py").map((c) => c.path)]);
}

// A component's own image when it differs from the repo's: a hooked language's, a Python project
// with its own manager next to Node ones, or a Node project with its own lockfile next to Python.
function componentImage(tree: string, c: Component, repoImage: string): string | null {
  const hooks = hooked(c);
  if (hooks) return hooks.image(tree, c.path);
  if (c.path === "." || !c.packageManager) return null;
  if (c.language === "py" && repoImage.startsWith("node:")) return pythonImage(tree, c.path, c.packageManager);
  if (nodeLang(c) && !repoImage.startsWith("node:")) return nodeImage(tree, [c.path]);
  return null;
}

export interface ImageGroup {
  image: string;
  // The assessed components that run here. The first group also runs the repo-wide commands.
  components: string[];
}

// Which image each assessed component runs in, the repo's image first. A repo that declares its own
// environment, or a run given --image, runs everything in that one image, as the repo set it up.
export function imagePlan(profile: Profile, tree: string, single?: string): ImageGroup[] {
  const repoImage = single ?? containerImage(profile, tree);
  const one = Boolean(single || profile.environmentJson?.install || profile.environmentJson?.build);
  const groups: ImageGroup[] = [{ image: repoImage, components: [] }];
  for (const c of profile.components.filter((x) => x.assessed)) {
    const image = (one ? null : componentImage(tree, c, repoImage)) ?? repoImage;
    let g = groups.find((x) => x.image === image);
    if (!g) groups.push((g = { image, components: [] }));
    g.components.push(c.id);
  }
  return groups;
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
