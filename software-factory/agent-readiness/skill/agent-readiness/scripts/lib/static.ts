import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { checkOnly, makeRuleFor, makeTargets as targetsIn } from "./contract.ts";
import { pyproject, readPackageJson } from "./profile.ts";
import { SUDO, insideString } from "./patterns.ts";
import { secretFindings } from "./secrets.ts";
import type { InstructionItem, Profile, SafetyFinding, ScanBound, SecretClass } from "./types.ts";
import { MAX_FILES, existsExact, inTreePath, listFiles, ownSkillPath, readText, sha256 } from "./util.ts";

// The PHP, Ruby, JVM and .NET tools are commands only when a version doesn't follow (`ruby 3.3`,
// `gradle 8.5` are prose), and `ruby` and `php` only with a flag or a file to run.
const COMMAND_START = /^(npm|pnpm|yarn|npx|pnpx|bunx|uvx|corepack|make|python3?|pip3?|pytest|uv|poetry|node|bun|cargo|go|tsc|eslint|ruff|cd\s+\S+\s*&&|\.\/[\w./-]+|(?:composer|bundle|bundler|rake|rspec|rails|bin\/(?:rails|rake|rspec|console|setup)|vendor\/bin\/[\w.-]+|mvn|mvnw|gradle|gradlew|dotnet)(?!\s+v?\d)|ruby(?=\s+(?:-|\S+\.rb\b|\S*\/))|php(?=\s+(?:-|\S+\.php\b|artisan\b|bin\/)))(\s|$)/;
const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "Gemfile.lock", "composer.lock", "Cargo.lock"]);
const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh", "terminal"]);
const PATH_LIKE = /^(?:\.{1,2}\/)[\w./-]+$|^[\w.-]+(?:\/[\w.-]+)*\/$|^(?:[\w.-]+\/)*[\w.-]+\.(md|mdc|ts|tsx|js|mjs|cjs|json|py|ya?ml|sh|toml|txt|sql)$/;

const INSTALL = /^(npm (ci|install|i)\b|pnpm (install|i)\b|yarn( install)?\s*$|yarn install\b|corepack \w+ install\b|bun (install|i)\b|pip3? install\b|python3? -m pip install\b|uv sync\b|poetry (install|sync)\b)/;
// A server or watcher that never exits: `npm run dev`, `npm run start:sse`, `make serve`, `--watch`.
const LONG_RUNNING = /\b(run )?(dev|start|serve|watch)([:_-][\w:.-]*)?(\s|$)|--watch\b|compose up\b|docker run\b/;
const NETWORK_PIPED = /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/;
const DESTRUCTIVE = /rm -rf\s+(\/|~|\*|\$HOME)|\bdrop (database|table)\b|db:(reset|drop)|migrate(:| )reset|\btruncate\b|prisma migrate reset/i;
const DEPLOY = /\b(npm|pnpm|yarn) publish\b|\bdeploy\b|vercel --prod|firebase deploy|terraform (apply|destroy)|kubectl (apply|delete)|helm (upgrade|install)|gh release create|fly deploy|seed-prod/i;
const ENV_READ = /(?:process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?\(?\[?['"]|getenv\(['"]|ENV\.fetch\(['"]|ENV\[['"])([A-Z][A-Z0-9_]*)/g;

// Every instruction result names the rule that produced it, and the report prints the rule's text.
export const INSTRUCTION_RULES: Record<string, string> = {
  "path-exists": "A file or folder the instructions name must exist in the repo, next to the instruction file, at the root or inside the package that owns it.",
  "script-exists": "A package-manager script the instructions run must be in the package.json of the folder it runs in.",
  "make-target": "A Make target the instructions run must be in the Makefile.",
  "package-manager": "Install and add commands must use the repo's package manager, and only npm, which every Node install has, may run scripts in a repo that uses another one.",
  "file-exists": "A file the instructions run, such as `node x.js` or `./script.sh`, must exist in the repo.",
  "folder-exists": "A folder the instructions change into, or pass with --directory, must exist in the repo.",
  "install-static": "Install commands are checked statically; the clean replay runs the frozen install instead.",
  replay: "A command that passes the static checks runs in a copy of the repo and must exit 0.",
  "replay-environment": "A replayed command that fails only because of the machine, such as a missing tool, the network or a credential, isn't counted against the repo.",
  "replay-budget": "No instruction starts once the audit's time budget is spent.",
  "replay-install": "Instructions replay only after the clean install succeeds.",
  "same-as-check": "An instruction that runs the same command as a check the audit already ran takes that check's result, and a failure counts once, under the check, not again as a wrong instruction.",
  consumer: "Usage for the package's users in a README, outside a section about developing the repo, isn't a step for working on this repo, unless it runs one of the repo's own scripts or Make targets.",
  "own-package": "A command that installs or runs this repo's own package, as its users would, isn't a step for working on this repo.",
  mention: "A command named in prose, as an example or inside a link, isn't given as a step to run.",
  negated: "A command the instructions say not to run isn't replayed.",
  elsewhere: "Steps written for another checkout or repository aren't checked against this one.",
  duplicate: "A README command that an earlier agent instruction file already gives is checked once, there.",
  vendored: "A third-party skill copied into the repo documents its own tool, not this repo.",
  placeholder: "A command with a placeholder to fill in can't be run as written.",
  interactive: "A command that asks questions as it runs can't be replayed unattended.",
  "adds-packages": "A command that adds or removes packages changes the dependencies, so it isn't replayed.",
  rewrites: "A lint or format command that rewrites files is run check-only by the commands check, not replayed as written.",
  links: "A command that links packages into the machine's global folder isn't replayed.",
  "built-program": "A program a build or a download makes first, such as `./app serve`, isn't in a clean checkout, so it isn't checked or replayed.",
  "unassessed-stack": "A command for a toolchain this audit doesn't assess, such as Go, isn't replayed.",
  downloads: "A runner command that downloads a package the repo doesn't depend on needs the network, which the replay doesn't provide.",
  risky: "A command that deploys, publishes, deletes data or pipes a download into a shell is never replayed.",
  "long-running": "A command that starts a long-running process, such as a dev server, isn't replayed.",
  sudo: "A command that uses sudo isn't replayed.",
  "machine-path": "A command that refers to a path on the author's machine isn't replayed.",
  "future-path": "A path the docs say will exist later isn't counted as stale.",
  "per-package": "A command written without its folder, whose script or file is in another package of the repo, runs in one of those packages, and the line doesn't say which, so it isn't replayed.",
  "pm-command": "A package-manager command that no package.json defines as a script, with words after it, reads as one of the package manager's own commands, so it isn't counted as a missing script.",
  waived: "A committed waiver marks this finding as a false positive; it no longer counts, and the report lists it.",
};

// A production credential: PROD, PRODUCTION or LIVE as a word of the name, next to a word that
// holds a secret or a connection string. PRODUCT_DATABASE_URL and MEDUSA_PRODUCTION_VERSION aren't.
export function prodCredential(name: string): boolean {
  const words = name.split("_");
  return words.some((w) => /^(PROD|PRODUCTION|LIVE)$/.test(w)) && words.some((w) => /^(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|DSN|URL|URI|CONNECTION)$/.test(w));
}

export function isRisky(cmd: string): boolean {
  return NETWORK_PIPED.test(cmd) || DESTRUCTIVE.test(cmd) || DEPLOY.test(cmd);
}

export type Cue = "example" | "negated" | "link_text" | "deleted" | "table_name";

interface Extracted {
  kind: "command" | "path";
  text: string;
  line: number;
  via: "fence" | "code" | "link";
  // The headings the item sits under, outermost first.
  headings: string[];
  cue?: Cue;
  // A checkout or repository the steps around it are written for, when it isn't this one.
  elsewhere?: string;
  // Another repository the paragraph names, for a path: the path is that repository's.
  otherRepo?: string;
  // The lockfile the line introducing a code block names, as in "**npm** (`package-lock.json`):",
  // when the guide gives one block per package manager.
  forLockfile?: string;
  // The folder of this repo the section says to work in.
  within?: string;
}

const EXAMPLE_CUE = /\b(like|such as|e\.g\.|eg\.|for example|for instance|i\.e\.|say|as in)[\s,:]*[("'`]*$/i;
const NEGATED_CUE = /\b(never|don't|do not|doesn't|does not|must not|mustn't|should not|shouldn't|avoid|instead of|rather than|not with|not by|nor)\b/i;
const DELETED_CUE = /\b(is|are|was|were|has been|have been|got)\s+(now\s+)?(gone|deleted|removed|retired|dropped)\b|\((deleted|removed|gone|retired)\)|\bno longer (exists?|used|there)\b|\bused to (be|live)\b/i;
// A folder named right after a span, for that span only: "`go generate ./...` in the `tsc` module",
// or "`pnpm run test:prepare` in `dev-packages/e2e-tests`" at the end of a clause.
const TRAILING_DIR = /^\s+(?:from\s+)?(?:in|inside|within)\s+(?:the\s+)?`([^`]+)`(?:\s+(?:module|package|crate|workspace|directory|folder|subdirectory|subfolder)\b|\s*(?=[.,;:)]|$))/i;
const ELSEWHERE_CUE = /\b(inside|within|in|work (?:in|from)|runs? (?:\w+ )?from|navigate to|go to|switch to|cd into)\s+(the\s+)?`([^`]+)`\s*(directory|folder|subdirectory|subfolder|sub-directory|repo|repository|checkout|clone|project)?/i;
// A span on either side of an arrow or "becomes" illustrates a convention, as in "`src/a.ts` →
// `test/a.test.ts`", rather than naming a file of this repo.
const MAPS_FROM = /^\s*(→|->|⟶|=>|becomes\b|turns into\b|maps to\b)/i;
const MAPS_TO = /(→|->|⟶|=>|\bbecomes|\bturns into|\bmaps to)\s*$/i;
// A paragraph that names another repository: paths in it are that repository's.
const OTHER_REPO: RegExp[] = [/`([\w.-]+\/[\w.-]+)`\s+(?:repo|repository)\b/i, /\b(?:repo|repository)\s*[:(]?\s*`([\w.-]+\/[\w.-]+)`/i, /\bin\s+the\s+(?:private\s+|public\s+)?([A-Z][\w.-]*)\s+(?:repo|repository)\b/];
const CHECKOUT_CUE = /\b(checked out|check it out|clone|cloned|checkout)\b/i;

// The prose right before an inline span, cut at the last clause break, so "don't run `a`, run `b`"
// reads `b` as a step. The period of "e.g." or "etc." isn't a break.
function clauseBefore(before: string): string {
  const masked = before.replace(/\b(e\.g|i\.e|eg|etc|vs|cf)\./gi, (m) => m.replace(/\./g, "\u0000"));
  return (masked.split(/[.!?;,]\s+|\s+(?:but|then|and then)\s+/).pop() ?? masked).replace(/\u0000/g, ".");
}

// The paragraph or list item each line sits in, joined into one line, so a cue on the line before
// a span, such as "(repo" ending one line and the repository's name starting the next, is seen.
function paragraphs(lines: string[]): string[] {
  const out = new Array<string>(lines.length).fill("");
  let start = 0;
  const flush = (end: number) => {
    const text = lines.slice(start, end).join(" ");
    for (let j = start; j < end; j++) out[j] = text;
    start = end;
  };
  lines.forEach((raw, i) => {
    if (!raw.trim() || /^\s*(```|#{1,6}\s)/.test(raw)) {
      flush(i);
      start = i + 1;
    } else if (i > start && /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) flush(i);
  });
  flush(lines.length);
  return out;
}

// The repository other than this one that a paragraph names, if any: "the private
// `langfuse/infrastructure` repo", "(repo `org/name`)", "in the Turborepo repository", or an
// `org/name` the paragraph says to clone or check out.
function otherRepoIn(text: string, exists?: (p: string) => boolean): string | undefined {
  for (const re of OTHER_REPO) {
    const name = text.match(re)?.[1];
    if (name && !exists?.(name.replace(/\/$/, ""))) return name;
  }
  if (CHECKOUT_CUE.test(text)) {
    for (const m of text.matchAll(/`([\w.-]+\/[\w.-]+)`/g)) if (!/\.\w+$/.test(m[1]) && !exists?.(m[1])) return m[1];
  }
  return undefined;
}

// The sentence or table cell around a position, so "`a` is gone" says nothing about `b` next to it.
function sentenceAt(raw: string, index: number): string {
  const breaks = /[.!?](?=\s)|\|/g;
  let start = 0;
  let end = raw.length;
  for (const m of raw.matchAll(breaks)) {
    if (m.index! < index) start = m.index! + 1;
    else {
      end = m.index!;
      break;
    }
  }
  return raw.slice(start, end);
}

function inLinkText(raw: string, start: number, end: number): boolean {
  const open = raw.lastIndexOf("[", start);
  return open >= 0 && raw.indexOf("]", open) >= end && /^[^[]*\]\(/.test(raw.slice(end));
}

const BACK_TO_ROOT = /\b(root (project )?(directory|folder)|repo(sitory)? root|top[- ]level (directory|folder))\b/i;

// A table column that names tools rather than giving commands: Runner, Tool, Framework.
const TOOL_COLUMN = /^(test )?(runner|tool|framework)s?$/i;

function tableCells(raw: string): string[] {
  return raw.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim().replace(/`/g, ""));
}

function indentOf(raw: string): number {
  return raw.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?/)?.[0].length ?? 0;
}

export function extractFromMarkdown(text: string, opts: { exists?: (p: string) => boolean } = {}): Extracted[] {
  const out: Extracted[] = [];
  const lines = text.split("\n");
  const paragraph = paragraphs(lines);
  let inFence = false;
  let fenceLang = "";
  let inFrontmatter = lines[0]?.trim() === "---";
  let pending: { text: string; line: number } | null = null;
  const headings: { level: number; text: string }[] = [];
  let away: { target: string; indent: number } | null = null;
  // A folder of this repo a step says to work in, such as "Navigate to the `ui` directory". It holds
  // to the end of the step's section (the next heading of the same or a higher level), or until a
  // line says to work from the root again, such as "(while in the root project directory)".
  let within: { dir: string; level: number } | null = null;
  // A `cd dir` line inside a code block sets the folder for the rest of that block: a folder of this
  // repo, or one the block leaves to the reader, such as `cd src/<server>`.
  let fenceDir: { within: string } | { elsewhere: string } | null = null;
  let fenceLockfile: string | undefined;
  // The header cells of the markdown table the line is in.
  let tableHeader: string[] | null = null;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (inFrontmatter) {
      if (i > 0 && raw.trim() === "---") inFrontmatter = false;
      return;
    }
    const fence = raw.match(/^\s*```(\w*)/);
    if (!inFence && within && BACK_TO_ROOT.test(raw)) within = null;
    if (!inFence && away && raw.trim() && indentOf(raw) <= away.indent && !fence) away = null;
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1].toLowerCase();
        const intro = lines.slice(0, i).reverse().find((l) => l.trim()) ?? "";
        fenceLockfile = /:\s*$/.test(intro) ? [...intro.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).find((s) => LOCKFILE_NAMES.has(s)) : undefined;
      } else inFence = false;
      pending = null;
      fenceDir = null;
      return;
    }
    const where = { headings: headings.map((h) => h.text), ...(away ? { elsewhere: away.target } : {}), ...(within ? { within: within.dir } : {}) };
    if (inFence) {
      if (!SHELL_LANGS.has(fenceLang)) return;
      const part = raw.trim().replace(/^\$\s+/, "");
      const joined: { text: string; line: number } = pending ? { text: `${pending.text} ${part}`, line: pending.line } : { text: part, line: lineNo };
      if (part.endsWith("\\")) {
        pending = { text: joined.text.slice(0, -1).trim(), line: joined.line };
        return;
      }
      pending = null;
      const cmd = joined.text.replace(/\s+#(\s.*)?$/, "").trim();
      const cd = cmd.match(/^cd\s+(\S+)$/)?.[1];
      if (cd) {
        const target = cd.replace(/\/$/, "");
        fenceDir = !PLACEHOLDER.test(target) && opts.exists?.(target) ? { within: target } : { elsewhere: target };
        return;
      }
      const inBlock = fenceDir ? ("within" in fenceDir ? { ...where, within: fenceDir.within } : { ...where, elsewhere: fenceDir.elsewhere }) : where;
      if (cmd && !cmd.startsWith("#") && COMMAND_START.test(cmd)) out.push({ kind: "command", text: cmd, line: joined.line, via: "fence", ...inBlock, ...(fenceLockfile ? { forLockfile: fenceLockfile } : {}) });
      return;
    }
    if (/^\s*\|/.test(raw)) {
      if (/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) tableHeader = tableCells(raw);
    } else tableHeader = null;
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: heading[2].replace(/`/g, "") });
      away = null;
      if (within && level <= within.level) within = null;
    }
    const awayStart = away;
    const withinStart = within;
    const scope = raw.match(ELSEWHERE_CUE);
    if (scope && opts.exists) {
      const target = scope[3].replace(/\/$/, "");
      const named = Boolean(scope[4]) || /^(navigate|go|switch|cd|work|runs?)\b/i.test(scope[1]);
      if (!opts.exists(target) && (target.includes("/") || scope[4])) away = { target: scope[3], indent: indentOf(raw) };
      else if (opts.exists(target) && named && !/\.\w+$/.test(target)) within = { dir: target, level: headings.length ? headings[headings.length - 1].level : 0 };
    }
    // A folder cue on this line holds for the spans before it ("`uv run pytest` in `src/<server>`")
    // when it points elsewhere, and for the spans after it when it names a folder to work in; never
    // for the folder it names.
    const cueStart = scope?.index ?? Infinity;
    const cueEnd = scope ? scope.index! + scope[0].length : Infinity;
    const headingTexts = headings.map((h) => h.text);
    const placeAt = (at: number) => {
      const a = away !== awayStart && at < cueStart ? away : awayStart;
      const w = within !== withinStart && at >= cueEnd ? within : withinStart;
      return { headings: headingTexts, ...(a ? { elsewhere: a.target } : {}), ...(w ? { within: w.dir } : {}) };
    };
    const here = placeAt(Infinity);
    const otherRepo = otherRepoIn(paragraph[i], opts.exists);
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      const before = clauseBefore(raw.slice(0, m.index));
      const column = tableHeader ? tableHeader[raw.slice(0, m.index).split("|").length - 2] : undefined;
      const after = raw.slice(m.index! + m[0].length);
      const mapped = MAPS_FROM.test(after) || MAPS_TO.test(raw.slice(0, m.index)) || (!raw.slice(0, m.index).trim() && MAPS_TO.test(lines[i - 1] ?? ""));
      const cue: Cue | undefined = inLinkText(raw, m.index!, m.index! + m[0].length) ? "link_text" : column && TOOL_COLUMN.test(column) ? "table_name" : EXAMPLE_CUE.test(before) ? "example" : NEGATED_CUE.test(before) ? "negated" : DELETED_CUE.test(sentenceAt(raw, m.index!)) ? "deleted" : undefined;
      const trailing = after.match(TRAILING_DIR)?.[1].replace(/\/$/, "");
      const at = placeAt(m.index!);
      const place = trailing && opts.exists?.(trailing) && !/\.\w+$/.test(trailing) && !at.elsewhere ? { ...at, within: trailing } : at;
      const base = { line: lineNo, via: "code" as const, ...place, ...(cue ? { cue } : {}) };
      if (COMMAND_START.test(span) && span.includes(" ")) out.push({ kind: "command", text: span, ...base });
      else if (PATH_LIKE.test(span) && !span.startsWith("http") && !span.includes("<")) out.push({ kind: "path", text: span, ...base, ...(mapped && !cue ? { cue: "example" as const } : {}), ...(otherRepo ? { otherRepo } : {}) });
    }
    for (const m of raw.matchAll(/\[[^\]]*\]\(([^)\s#?]+)(?:[?#][^)\s]*)?(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      // A scheme, an anchor or a protocol-relative //host link points off the repo.
      if (/^([a-z][\w+.-]*:|#|\/\/)/i.test(target) || target.includes("<")) continue;
      out.push({ kind: "path", text: target, line: lineNo, via: "link", ...here, ...(otherRepo ? { otherRepo } : {}) });
    }
  });
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.kind}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scriptsAt(tree: string, dir: string): { scripts: Record<string, string>; at: string } | null {
  let d = dir;
  while (true) {
    const pkg = readPackageJson(join(tree, d));
    if (pkg) return { scripts: pkg.scripts ?? {}, at: d };
    if (d === "." || d === "") return null;
    d = dirname(d);
  }
}

// The names GNU make reads in a folder, in the order it tries them.
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];

function makefileIn(tree: string, dir: string): string | null {
  const name = MAKEFILES.find((n) => existsExact(tree, join(dir, n)));
  return name ? join(dir, name) : null;
}

// The targets `make` sees from a folder: its makefile's and those of the files it includes. open:
// an include the audit couldn't read, such as one named by a variable or a glob, or one not in the
// tree, so a target it didn't find may still be defined.
function makeTargets(tree: string, dir: string): { targets: string[]; open: boolean } | null {
  for (const d of [dir, "."]) {
    const file = makefileIn(tree, d);
    if (!file) continue;
    const targets: string[] = [];
    const seen = new Set<string>();
    let open = false;
    const read = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = readText(join(tree, rel));
      targets.push(...targetsIn(text));
      for (const m of text.matchAll(/^[ \t]*-?s?include[ \t]+(.+)$/gm)) {
        for (const name of m[1].replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean)) {
          const inc = normalize(join(d, name));
          if (/[$*?[]/.test(name) || !existsExact(tree, inc)) open = true;
          else read(inc);
        }
      }
    };
    read(file);
    return { targets, open };
  }
  return null;
}

const OTHER_STACK_RECIPES: Record<string, RegExp> = { go: /^\s*(go|golangci-lint|gofmt)\s/m, rust: /^\s*(cargo|rustc)\s/m };

// The commands a Make target runs, without the @ and - prefixes.
export function makeRecipe(tree: string, dir: string, target: string): string {
  for (const d of [dir, "."]) {
    const file = makefileIn(tree, d);
    if (!file) continue;
    const text = readText(join(tree, file));
    const rule = makeRuleFor(targetsIn(text), target);
    if (!rule) continue;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(?!=)`).test(l));
    if (at < 0) continue;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!/^\t/.test(l)) break;
      body.push(l.replace(/^\t[@-]*/, ""));
    }
    return body.join("\n");
  }
  return "";
}

// The folder a command from an instruction file runs in: the nearest folder at or above the file
// with a package manifest, so a skill under .claude/skills/ runs at the root and a package's own
// AGENTS.md runs in that package.
export function packageDirOf(tree: string, file: string): string {
  let d = dirname(file) === "" ? "." : dirname(file);
  while (d !== "." && d !== "") {
    if (["package.json", "pyproject.toml", "setup.py"].some((m) => existsExact(tree, join(d, m)))) return d;
    d = dirname(d);
  }
  return ".";
}

// The shell pieces of a command line: split on &&, ||, ;, | and &, outside quotes.
export function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') cur += cmd[++i] ?? "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (cmd[++i] ?? "");
      continue;
    }
    if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function argv(segment: string): string[] {
  const words = segment.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] === "env" || words[0] === "time") words.shift();
  return words.filter(Boolean);
}

// Names this repo publishes, as packages or commands: what its users install and run.
interface RepoNames {
  own: Set<string>;
  deps: Set<string>;
}

const KNOWN_BINS: Record<string, string> = { tsc: "typescript", tsserver: "typescript", playwright: "@playwright/test", biome: "@biomejs/biome", "ts-node": "ts-node", tsx: "tsx", vite: "vite", vitest: "vitest", jest: "jest", eslint: "eslint", prettier: "prettier", next: "next", turbo: "turbo", changeset: "@changesets/cli", "lint-staged": "lint-staged", husky: "husky", rimraf: "rimraf", tsup: "tsup", tsdown: "tsdown", attw: "@arethetypeswrong/cli" };

function repoNames(tree: string, profile: Profile): RepoNames {
  const own = new Set<string>();
  const deps = new Set<string>();
  for (const m of profile.manifests) {
    const dir = dirname(m);
    if (m.endsWith("package.json")) {
      const pkg = readPackageJson(join(tree, dir)) as (ReturnType<typeof readPackageJson> & { bin?: string | Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }) | null;
      if (!pkg) continue;
      if (pkg.name) own.add(pkg.name);
      if (pkg.name && typeof pkg.bin === "string") own.add(pkg.name.replace(/^@[^/]+\//, ""));
      if (pkg.bin && typeof pkg.bin === "object") for (const b of Object.keys(pkg.bin)) own.add(b);
      for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) for (const d of Object.keys(group ?? {})) deps.add(d);
    } else if (m.endsWith("pyproject.toml")) {
      const text = pyproject(join(tree, dir));
      const name = text.match(/^\[project\][\s\S]*?^name\s*=\s*["']([^"']+)["']/m)?.[1];
      if (name) own.add(name);
      const scripts = text.match(/^\[project\.scripts\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
      for (const s of scripts.matchAll(/^["']?([\w.-]+)["']?\s*=/gm)) own.add(s[1]);
    }
  }
  return { own, deps };
}

function packageName(spec: string): string {
  return spec.startsWith("@") ? spec.replace(/^(@[^/@]+\/[^@]+)@.*$/, "$1") : spec.replace(/@.*$/, "");
}

function localTool(names: RepoNames, pkg: string): boolean {
  if (names.deps.has(pkg) || names.own.has(pkg)) return true;
  if (KNOWN_BINS[pkg] && names.deps.has(KNOWN_BINS[pkg])) return true;
  return [...names.deps].some((d) => d.replace(/^@[^/]+\//, "") === pkg);
}

const BUILTIN_RUN = new Set(["test", "start", "stop", "restart"]);
const PM_COMMANDS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "exec", "dlx", "x", "init", "create", "why", "list", "ls", "outdated", "update", "up", "upgrade", "audit", "link", "unlink", "pack", "publish", "version", "config", "help", "workspace", "workspaces", "set", "plugin", "constraints", "dedupe", "npm", "info", "cache", "bin", "patch", "unplug", "rebuild", "node", "global", "import", "licenses", "store", "env", "setup", "prune", "root", "fetch", "deploy", "recursive", "-r", "whoami", "login", "logout", "deprecate", "dist-tag", "owner", "search", "view", "doctor", "explain", "run", "run-script"]);
const WORKSPACE_FLAG = /^(-w|--workspace|--filter|-F|--dir|-C|--prefix|--cwd)(=(.*))?$/;
const RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"]);
const BUILD_OUTPUT = /(^|\/)(dist|build|out|\.next|coverage|target|node_modules)\//;
const OTHER_STACKS: Record<string, string> = { go: "go", cargo: "rust" };

interface CheckCtx {
  tree: string;
  profile: Profile;
  fileDir: string;
  names: RepoNames;
  via: Extracted["via"];
  // Folders a guide of the repo says one of its steps makes, such as a clone of a starter app.
  made: string[];
  files: () => string[];
}

// A static check's verdict on one command. skip and access name why it isn't replayed; repo says
// it runs one of the repo's own scripts or targets, so it is about this repo wherever it's written.
interface Check {
  result: "pass" | "fail";
  rule: string;
  reason?: string;
  skip?: string;
  access?: string;
  repo?: boolean;
}

const PASS: Check = { result: "pass", rule: "replay" };

function pathIn(ctx: CheckCtx, dir: string, p: string): boolean {
  return [dir, ctx.fileDir, "."].some((d) => existsExact(ctx.tree, normalize(join(d, p))));
}

function pmAt(ctx: CheckCtx, dir: string): string | null {
  const owner = ctx.profile.components.filter((c) => c.packageManager && (c.path === "." || dir === c.path || dir.startsWith(c.path + "/"))).sort((a, b) => b.path.length - a.path.length)[0];
  return owner?.packageManager ?? ctx.profile.packageManager;
}

function checkRunner(ctx: CheckCtx, dir: string, words: string[]): Check {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += /^(-p|--package)$/.test(words[i]) ? 2 : 1;
  const spec = words[i];
  if (!spec) return PASS;
  if (/^\.{1,2}\//.test(spec)) return pathIn(ctx, dir, spec) ? PASS : { result: "fail", rule: "file-exists", reason: `${spec} doesn't exist` };
  const pkg = packageName(spec);
  if (ctx.names.own.has(pkg) && !ctx.names.deps.has(pkg)) return { ...PASS, rule: "own-package", skip: `not replayed: it runs ${pkg}, this repo's own package, as its users would` };
  if (localTool(ctx.names, pkg)) return PASS;
  return { ...PASS, rule: "downloads", access: `not replayed: it downloads ${pkg} from the registry, which the replay doesn't provide` };
}

function checkPackageManager(ctx: CheckCtx, dir: string, all: string[]): Check {
  // Folder and workspace flags, with their values, come out first: `pnpm --dir web test` runs web's test.
  const folders: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(WORKSPACE_FLAG);
    if (!m || i === 0) {
      words.push(all[i]);
      continue;
    }
    // pnpm's -w means the workspace root and takes no value.
    if (all[0] === "pnpm" && m[1] === "-w" && !m[3]) continue;
    const value = m[3] ?? all[++i];
    if (value !== undefined) folders.push(value);
  }
  const tool = words[0];
  const sub = words[1];
  if (tool !== "npm" && sub && ["dlx", "x"].includes(sub)) return checkRunner(ctx, dir, words.slice(1));
  if (sub && !/^(-|[a-z@])[\w:.@/=-]*$/i.test(sub)) return { ...PASS, rule: "mention", skip: "not replayed: it is output quoted in the instructions, not a command" };
  if (sub === "link" || sub === "unlink") return { ...PASS, rule: "links", skip: "not replayed: it links packages into the machine's global folder" };
  const pm = pmAt(ctx, dir);
  const nodeRepo = pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun";
  const otherPm = nodeRepo && tool !== pm;
  const args = words.slice(2).filter((w) => !w.startsWith("-"));
  const installs = !sub ? tool === "yarn" : ["install", "i", "ci", "add"].includes(sub);
  if (installs) {
    const pkgs = sub === "ci" ? [] : args.map(packageName);
    const mine = pkgs.find((p) => ctx.names.own.has(p) && !ctx.names.deps.has(p));
    if (mine) return { ...PASS, rule: "own-package", skip: `not replayed: it installs ${mine}, this repo's own package, as its users would` };
    if (otherPm) return { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` };
    return { ...PASS, rule: "install-static", repo: pkgs.length === 0 };
  }
  let scriptDir = dir;
  for (const value of folders) {
    if (!value || MACHINE_PATH.test(` ${value}`)) continue;
    if (/^\.{0,2}\//.test(value) || (value.includes("/") && !value.startsWith("@") && !/[*{]/.test(value))) {
      if (!pathIn(ctx, dir, value)) return { result: "fail", rule: "folder-exists", reason: `there is no ${value} folder` };
      scriptDir = normalize(join(dir, value));
      if (!existsExact(ctx.tree, scriptDir)) scriptDir = normalize(value);
    } else return otherPm && tool !== "npm" ? { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` } : PASS;
  }
  let script: string | null = null;
  if (sub === "run" || sub === "run-script") script = words.slice(2).find((w) => !w.startsWith("-")) ?? null;
  else if (sub && BUILTIN_RUN.has(sub)) script = sub;
  else if (tool !== "npm" && sub && !PM_COMMANDS.has(sub) && !sub.startsWith("-")) script = sub;
  if (!script) return PASS;
  if (otherPm && tool !== "npm") return { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` };
  const found = scriptsAt(ctx.tree, scriptDir) ?? scriptsAt(ctx.tree, ".");
  if (!found || !(script in found.scripts)) {
    const where = found ? (found.at === "." ? "" : found.at + "/") + "package.json" : "package.json";
    const others = packagesWithScript(ctx, script).filter((d) => d !== found?.at);
    // Written without its folder, as "`pnpm run seed`" in a package's guide for a root script, or a
    // root guide's "`pnpm run test:watch`" for web's: it runs in one of the packages that have it.
    if (others.length) return { ...PASS, rule: "per-package", skip: `not replayed: ${where} has no "${script}" script, ${list(others.map((d) => (d === "." ? "the root package.json" : `${d}/package.json`)))} ${others.length > 1 ? "have" : "has"} one, and the line doesn't say which folder it runs in` };
    // `pnpm change check`: a word after it, and no package anywhere has the script, so it reads as one of
    // the package manager's own commands, from a version newer than the list this audit knows.
    const shorthand = sub === script && tool !== "npm" && !PM_COMMANDS.has(sub);
    if (shorthand && args.length > 0) return { ...PASS, rule: "pm-command", skip: `not replayed: no package.json has a "${script}" script, so \`${tool} ${script}\` reads as a ${tool} command this audit doesn't know` };
    return { result: "fail", rule: "script-exists", reason: `no "${script}" script in ${where}` };
  }
  return { ...PASS, repo: true };
}

function list(xs: string[]): string {
  const shown = xs.length > 3 ? [...xs.slice(0, 3), `${xs.length - 3} more`] : xs;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
}

// The folders of the repo's package.json files that define a script.
function packagesWithScript(ctx: CheckCtx, script: string): string[] {
  return ctx.profile.manifests
    .filter((m) => basename(m) === "package.json")
    .map((m) => (dirname(m) === "" ? "." : dirname(m)))
    .filter((d) => script in (readPackageJson(join(ctx.tree, d))?.scripts ?? {}))
    .sort();
}

// The file a node or python command runs, past the options that take a value; null for -e, -c or -m.
function scriptArg(words: string[]): string | null | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (/^(-e|--eval|-p|--print|-c|-m)$/.test(w)) return null;
    if (/^(-r|--require|--import|--loader|--experimental-loader|--env-file|-W|-X)$/.test(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w;
  }
  return undefined;
}

function checkOne(ctx: CheckCtx, dir: string, words: string[]): Check {
  const tool = words[0];
  if (RUNNERS.has(tool)) return checkRunner(ctx, dir, words);
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    if (tool === "bun" && words[1] && !["run", "install", "i", "add", "remove", "x", "link", "unlink"].includes(words[1]) && /\.\w+$/.test(words[1])) return checkOne(ctx, dir, ["node", ...words.slice(1)]);
    return checkPackageManager(ctx, dir, words);
  }
  if (tool === "make") {
    const cIdx = words.indexOf("-C");
    const mdir = cIdx > 0 && words[cIdx + 1] ? normalize(join(dir, words[cIdx + 1])) : ctx.fileDir;
    const found = makeTargets(ctx.tree, mdir);
    const target = words.slice(1).find((w, i) => !w.startsWith("-") && !w.includes("=") && words[i] !== "-C");
    if (!found) return { result: "fail", rule: "make-target", reason: "there is no Makefile" };
    // A target the files read don't define is wrong only when nothing it includes went unread.
    if (target && !makeRuleFor(found.targets, target)) return found.open ? { ...PASS, rule: "make-target", repo: true } : { result: "fail", rule: "make-target", reason: `the Makefile has no "${target}" target` };
    const recipe = target ? makeRecipe(ctx.tree, mdir, target) : "";
    const stack = Object.entries(OTHER_STACK_RECIPES).find(([, re]) => re.test(recipe))?.[0];
    if (stack && !ctx.profile.components.some((c) => c.assessed && c.stack === stack)) {
      return { ...PASS, rule: "unassessed-stack", skip: `not replayed: the "${target}" target runs ${stack === "go" ? "Go" : "Rust"}, and this audit doesn't assess that part of the repo` };
    }
    return { ...PASS, rule: "make-target", repo: true };
  }
  if (OTHER_STACKS[tool] && !ctx.profile.components.some((c) => c.assessed && c.stack === OTHER_STACKS[tool])) {
    return { ...PASS, rule: "unassessed-stack", skip: `not replayed: it's a ${tool === "go" ? "Go" : "Rust"} command, and this audit doesn't assess that part of the repo` };
  }
  if (/^\.{1,2}\//.test(tool)) {
    if (pathIn(ctx, dir, tool)) return { ...PASS, rule: "file-exists" };
    if (!/\.\w+$/.test(basename(tool)) && !tool.slice(2).includes("/")) return { ...PASS, rule: "built-program", skip: `not replayed: it runs ${tool}, a program a build or a download makes first` };
    return { result: "fail", rule: "file-exists", reason: `${tool} doesn't exist` };
  }
  if (tool === "uv") {
    for (let i = 1; i < words.length; i++) {
      const m = words[i].match(/^--(directory|project)(=(.*))?$/);
      const value = m ? (m[3] ?? words[i + 1]) : undefined;
      if (value && !pathIn(ctx, dir, value)) return { result: "fail", rule: "folder-exists", reason: `there is no ${value} folder` };
    }
    return PASS;
  }
  if (/^(node|python3?|tsx|ts-node)$/.test(tool)) {
    const file = scriptArg(words);
    if (file === undefined && ctx.via === "code" && !words.includes("--test")) return { ...PASS, rule: "mention", skip: `not replayed: it names ${tool}'s options, not a step to run` };
    if (!file || file.startsWith("$") || BUILD_OUTPUT.test(normalize(file))) return PASS;
    if (!/[./]/.test(file) && tool !== "node") return PASS;
    const variants = tool === "node" && !/\.\w+$/.test(file) ? [file, `${file}.js`, `${file}.mjs`, `${file}.cjs`, `${file}/index.js`] : [file];
    if (variants.some((v) => pathIn(ctx, dir, v))) return { ...PASS, rule: "file-exists" };
    // `python manage.py test` from a guide whose project sits in netbox/: it runs in a folder that has
    // the file, and the line doesn't say which.
    const tail = "/" + normalize(file);
    const holders = [...new Set(ctx.files().filter((f) => f.endsWith(tail)).map((f) => f.slice(0, -tail.length)))].sort();
    if (holders.length) return { ...PASS, rule: "per-package", skip: `not replayed: ${file} isn't in ${dir === "." ? "the root" : dir}, ${list(holders.map((h) => `${h}/`))} ${holders.length > 1 ? "have" : "has"} one, and the line doesn't say which folder it runs in` };
    return { result: "fail", rule: "file-exists", reason: `${file} doesn't exist` };
  }
  return PASS;
}

// Every piece of a command line is checked in order, following `cd`, so `cd web && npm test` checks web's scripts.
function checkCommand(cmd: string, ctx: CheckCtx, start: string): Check {
  let dir = start;
  let repo = false;
  let last: Check = PASS;
  for (const seg of shellSegments(cmd)) {
    const words = argv(seg);
    if (!words.length) continue;
    if (words[0] === "cd") {
      const target = words[1];
      if (!target || target === "-" || target.startsWith("$") || MACHINE_PATH.test(` ${target}`)) continue;
      const next = normalize(join(dir, target));
      if (next.startsWith("..")) continue;
      if (existsExact(ctx.tree, next)) dir = next;
      else if (existsExact(ctx.tree, normalize(target))) dir = normalize(target);
      else if (ctx.made.some((d) => within(next, d) || within(normalize(target), d))) return { ...PASS, rule: "built-program", skip: `not replayed: it works in ${target}, a folder a step of the repo's guides makes, which a clean checkout doesn't have` };
      else return { result: "fail", rule: "folder-exists", reason: `there is no ${target} folder to cd into` };
      continue;
    }
    if (!COMMAND_START.test(words.join(" "))) continue;
    const r = checkOne(ctx, dir, words);
    if (r.result === "fail" || r.skip || r.access) return r;
    repo ||= Boolean(r.repo);
    last = r;
  }
  return { ...last, repo };
}

const MACHINE_PATH = /(^|\s|=)(~\/|\$HOME\b|\/Users\/|\/home\/[a-z])/;

// `tree` and `dir` let a Make target whose recipe only launches a server count as long-running too.
function categorize(cmd: string, tree?: string, dir?: string): InstructionItem["category"] {
  if (isRisky(cmd)) return "risky";
  if (SUDO.test(cmd)) return "needs_access";
  if (INSTALL.test(cmd)) return "install";
  if (LONG_RUNNING.test(cmd)) return "long_running";
  const target = tree !== undefined ? cmd.trim().match(/^make\s+([\w./-]+)\s*$/)?.[1] : undefined;
  if (target) {
    const recipe = makeRecipe(tree!, dir ?? ".", target).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (recipe.length > 0 && recipe.every((l) => LONG_RUNNING.test(l))) return "long_running";
  }
  if (MACHINE_PATH.test(cmd)) return "needs_access";
  return "replay";
}

// A path the build writes, so a fresh checkout doesn't have it: "baselines are written below `out/`".
const GENERATED = /\b(is|are|gets?|get)\s+(written|generated|emitted|produced)\s+(below|under|to|into|in)\b/i;
// A path that lives only on a contributor's machine: "configs generated locally and not committed".
const NOT_COMMITTED = /\b(not (committed|checked in|tracked)|generated locally|git-?ignored)\b/i;
// Folders a tool writes as it runs: caches, virtualenvs, build and output folders, such as
// `.build/mypy-venvs/`, `.otelc-build/` or a skill's `output/`.
const MADE_SEGMENT = /(^|\/)(output|\.[\w-]*build[\w-]*|[\w.-]*_cache|\.cache|\.?venvs?|[\w-]+-venvs|__pycache__)\//i;
// A file name to fill in: `version-X.Y.md`, `vYYYY_MM_DD.py`.
const PATH_TEMPLATE = /(?<![A-Za-z])X\.Y(\.Z)?(?![A-Za-z])|YYYY/;
// A web address written without its scheme: `airflow.apache.org/registry/`.
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(org|com|io|dev|net|app|ai|co|sh|cloud)\//i;
// "`pnpm server:setup` clones spree-starter into `./server/`": a folder a step of the guide makes.
const MAKES_FOLDER = /\b(clones?|creates?|generates?|scaffolds?|sets up)\b[^.`]{0,120}?\b(?:into|in|at|under)\s+`([^`]+)`/gi;

function madeFolders(text: string, exists: (p: string) => boolean): string[] {
  const prose = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return [...prose.matchAll(MAKES_FOLDER)].map((m) => normalize(m[2].replace(/\/$/, ""))).filter((d) => d !== "." && !d.startsWith("..") && !/\.\w+$/.test(d) && !exists(d));
}

// Paths a guide says stay on the contributor's machine, so another guide naming them isn't stale.
function uncommittedPaths(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((l, i) => (NOT_COMMITTED.test(l) || NOT_COMMITTED.test(leadIn(lines, i)) ? [...l.matchAll(/`([^`]+)`/g)].map((m) => normalize(m[1].trim().replace(/\/$/, ""))) : []));
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

// The line a list item hangs from: its parent item, or the line that introduces the list, such as
// "Tool-specific configs generated locally and not committed:".
function leadIn(lines: string[], at: number): string {
  const lead = (s: string) => s.match(/^\s*/)![0].length;
  const own = lead(lines[at] ?? "");
  for (let j = at - 1; j >= 0; j--) {
    const l = lines[j];
    if (!l.trim()) return "";
    if (lead(l) < own) return l;
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) return /:\s*$/.test(l) ? l : "";
  }
  return "";
}

// `task-sdk/.../coordinators/java/coordinator.py`: a path shortened with `...`, found when a tracked
// path has the same start and end.
function abbreviated(files: string[], rel: string): boolean {
  if (!rel.includes("/.../")) return false;
  const [head, tail] = [rel.slice(0, rel.indexOf("/.../")), rel.slice(rel.indexOf("/.../") + 4)];
  return files.some((f) => f.startsWith(head + "/") && (f.endsWith(tail) || f.includes(tail + "/")));
}

const FUTURE = /\b(will (be )?(add|creat|live|hold|contain)\w*|(to be|not yet) (added|created|written)|(added|created|written|coming) (later|as|when|once)|later on|planned|upcoming|in the future|doesn't exist yet|does not exist yet|TODO)\b/i;

// Commands an instruction shows as a template, asks questions, or changes the dependencies with.
// None of them can be replayed as written, so they are listed as skipped instead.
const PLACEHOLDER = /<[A-Za-z][\w.:/ -]*[\w.]>|<[A-Za-z]>|\{\{[^}]+\}\}|…|(^|\s)\.\.\.(\s|$)/;
// A launcher with nothing after it, as prose names it: "`uv run` creates the venv".
const LAUNCHER_ONLY = /^(uv run|uvx|npx|pnpx|bunx|npm (run|exec)|pnpm (run|exec|dlx)|yarn (run|exec|dlx)|poetry run|pipenv run|bundle exec|go run|cargo run|dotnet run)$/;
// A lowercase shell variable, which only the lines around it (a loop, an earlier assignment) set.
const SHELL_VARIABLE = /\$\{?([a-z_][a-z0-9_]*)\}?/;
const RUNNER = String.raw`(npx|bunx|pnpx|(corepack\s+)?(pnpm|yarn)\s+dlx)\s+(-\S+\s+)*`;
const INTERACTIVE = new RegExp(String.raw`^(corepack\s+)?(npm|pnpm|yarn|bun)\s+(init|create|login|adduser)\b|^${RUNNER}(create-[\w-]+|\S+\s+init)\b|(^|\s)(auth\s+)?login(\s|$)|\s(-i|--interactive)(\s|$)|^(node|python3?)\s*$`);
// Appraisal installs a bundle per gemfile (`appraisal install`) and runs a command under each; neither
// works from the one bundle a clean checkout's `bundle install` sets up.
const APPRAISAL = /^(bundle\s+exec\s+)?appraisal(\s+(?!list\b|version\b|help\b)\S|\s*$)/;
const ADDS_PACKAGES = new RegExp(String.raw`^(corepack\s+)?(pnpm|yarn|bun)\s+(add|remove|rm|uninstall)\b|^npm\s+(i|install|add|uninstall|rm|remove)\b(\s+-\S+)*\s+[^-\s]|^(python3?\s+-m\s+)?pip3?\s+install\s+(?!.*(\s|^)(-r|-e|--requirement|--editable|\.)(\s|$))|^(uv|poetry|pdm)\s+(add|remove)\b|^${RUNNER}\S+\s+add\b`);

// `cwd`: the folder the command runs in, so a path that climbs out of the repository is seen.
function skippedReason(cmd: string, cwd = "."): { reason: string; rule: string } | null {
  if (PLACEHOLDER.test(cmd)) return { reason: "not replayed: it has a placeholder to fill in", rule: "placeholder" };
  if (LAUNCHER_ONLY.test(cmd.trim())) return { reason: "not replayed: it names the launcher, not a command for it to run", rule: "mention" };
  const outside = [...cmd.matchAll(/(?:^|[\s=])(\.\.(?:\/[^\s"'`;&|]*)?)/g)].map((m) => m[1]).find((p) => normalize(join(cwd, p)).startsWith(".."));
  if (outside) return { reason: `not replayed: it works in ${outside}, outside this repository`, rule: "outside-repo" };
  const variable = cmd.match(SHELL_VARIABLE);
  if (variable) return { reason: `not replayed: it uses $${variable[1]}, a shell variable the lines around it set`, rule: "placeholder" };
  if (INTERACTIVE.test(cmd)) return { reason: "not replayed: it asks questions as it runs", rule: "interactive" };
  if (ADDS_PACKAGES.test(cmd)) return { reason: "not replayed: it adds or removes packages", rule: "adds-packages" };
  if (APPRAISAL.test(cmd)) return { reason: "not replayed: it runs under each gemfile in Appraisals, whose gems `appraisal install` adds first", rule: "adds-packages" };
  return null;
}

// A documented lint or format command that rewrites files, directly or through the script it calls.
// The commands check runs its check-only form; replaying it as written would rewrite the copy.
function writesFiles(cmd: string, tree: string, fileDir: string, profile: Profile): string | null {
  const scripts = (scriptsAt(tree, fileDir) ?? scriptsAt(tree, "."))?.scripts ?? {};
  const { changes } = checkOnly(cmd, scripts, profile.packageManager);
  return changes.length ? `not replayed: it rewrites files as written; the commands check runs it check-only (${changes.join(", ")})` : null;
}

const SKILL_FILE = /^\.(cursor|claude|agents)\/skills\/([^/]+)\/SKILL\.md$/;

// A third-party skill copied into the repo documents its own tool, not this repo, so its commands
// aren't replayed. It is vendored when skills-lock.json lists it, a license ships with it, or its
// frontmatter names where it came from.
export function vendoredSkills(tree: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let lock: Record<string, { source?: string }> = {};
  try {
    lock = existsExact(tree, "skills-lock.json") ? ((JSON.parse(readText(join(tree, "skills-lock.json"))) as { skills?: typeof lock }).skills ?? {}) : {};
  } catch {
    lock = {};
  }
  // dotagents lists each skill in agents.toml with where it comes from; `path:` is the repo's own.
  const dotagents = new Map<string, string>();
  const toml = existsExact(tree, "agents.toml") ? readText(join(tree, "agents.toml")) : "";
  for (const block of toml.split(/^\[\[skills\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*"([^"]+)"/m)?.[1];
    if (name && source && !source.startsWith("path:")) dotagents.set(name, source);
  }
  for (const file of files) {
    const m = file.match(SKILL_FILE);
    if (!m) continue;
    const name = m[2];
    const dir = join(tree, dirname(file));
    const front = readText(join(tree, file)).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const from = front.match(/^(source|repository|upstream):\s*(.+)$/m)?.[2]?.trim();
    if (name in lock) out.set(file, `${lock[name].source ? `${lock[name].source}, ` : ""}listed in skills-lock.json`);
    else if (dotagents.has(name)) out.set(file, `${dotagents.get(name)}, listed in agents.toml`);
    else if (from) out.set(file, `from ${from}`);
    else if (/^license:/m.test(front) || listFiles(dir).some((f) => /^LICEN[CS]E(\.\w+)?$/i.test(f))) out.set(file, "it ships its own license");
  }
  return out;
}

// The same instruction file reached twice, through a symlink or as an identical copy, is checked once.
function duplicateOf(tree: string, file: string, seen: Map<string, string>): string | null {
  let key: string;
  try {
    key = `${realpathSync(join(tree, file))}`;
  } catch {
    return null;
  }
  const digest = `sha:${sha256(readText(join(tree, file)))}`;
  const first = seen.get(key) ?? (SKILL_FILE.test(file) ? seen.get(digest) : undefined);
  if (first) return first;
  seen.set(key, file);
  if (SKILL_FILE.test(file)) seen.set(digest, file);
  return null;
}

const README = /(^|\/)readme\.md$/i;
const DEV_HEADING = /contribut|develop|hacking|local (dev|setup|install)|from source|build(ing)? (it |the [\w ]+ )?locally|running (the )?tests|run(ning)? (it )?locally|\btesting\b|set ?up for|working on|maintain/i;

// Tracked paths that end in the given one, for a package-relative path written from the root:
// `server/index.ts` in a monorepo skill means src/everything/server/index.ts.
function packageRelative(files: string[], scope: string, rel: string): boolean {
  const tail = "/" + rel.replace(/\/$/, "");
  return files.some((f) => (scope === "." || f.startsWith(scope + "/")) && (f.endsWith(tail) || f.includes(tail + "/")));
}

const CUE_SKIP: Record<Cue, { reason: string; rule: string }> = {
  example: { reason: "not replayed: it's mentioned as an example, not given as a step", rule: "mention" },
  link_text: { reason: "not replayed: it's the text of a link, not a step", rule: "mention" },
  negated: { reason: "not replayed: the instructions say not to run it", rule: "negated" },
  deleted: { reason: "", rule: "path-exists" },
  table_name: { reason: "not replayed: it names a tool in a table's runner or tool column, not a command to run", rule: "mention" },
};

export function instructionItems(tree: string, profile: Profile): InstructionItem[] {
  const items: InstructionItem[] = [];
  let n = 1;
  let files: string[] | null = null;
  let basenames: Set<string> | null = null;
  const tracked = () => (files ??= listFiles(tree, { includeHidden: true }));
  const vendored = vendoredSkills(tree, profile.instructionFiles);
  const seen = new Map<string, string>();
  const listed = new Set(profile.instructionFiles);
  const names = repoNames(tree, profile);
  const earlier = new Map<string, string>();
  // What one guide says about a folder holds for the others: spree's CONTRIBUTING.md says a setup
  // step clones the app into server/, and its AGENTS.md runs `cd server && ...`.
  const own = profile.instructionFiles.filter((f) => !vendored.has(f));
  const texts = new Map(own.map((f) => [f, readText(join(tree, f))]));
  const rootExists = (p: string) => existsExact(tree, p);
  const madeAnywhere = [...new Set(own.flatMap((f) => madeFolders(texts.get(f)!, (p) => existsExact(tree, normalize(join(dirname(f), p))) || rootExists(p))))];
  const uncommitted = new Set(own.flatMap((f) => uncommittedPaths(texts.get(f)!)));
  for (const file of profile.instructionFiles) {
    // Reached through a symlink to a file the scan also lists: check it once, at its tracked path.
    const real = inTreePath(tree, file);
    if (real && real !== file && listed.has(real)) continue;
    if (duplicateOf(tree, file, seen)) continue;
    const fileDir = dirname(file) === "" ? "." : dirname(file);
    // A skill's commands are written for the repository root, where the agent runs them.
    const cmdDir = SKILL_FILE.test(file) ? "." : fileDir;
    const pkgDir = packageDirOf(tree, file);
    const text = readText(join(tree, file));
    const lines = text.split("\n");
    const thirdParty = vendored.get(file);
    const readme = README.test(file);
    const fromHere = (p: string) => existsExact(tree, normalize(join(fileDir, p))) || existsExact(tree, p);
    const ctx: CheckCtx = { tree, profile, fileDir, names, via: "fence", made: madeAnywhere, files: tracked };
    for (const e of extractFromMarkdown(text, { exists: fromHere })) {
      // A vendored skill's paths belong to its own workflow, such as the plans it writes, not this repo.
      if (e.kind === "path" && thirdParty) continue;
      if (e.kind === "path") {
        // `./internal/appsec/...` is Go's pattern for a folder and everything under it.
        const rel = e.text.replace(/\/\.\.\.$/, "").replace(/\/$/, "");
        const fromFile = normalize(join(fileDir, rel));
        if (fromFile.startsWith("..") && normalize(rel).startsWith("..")) continue;
        const found = existsExact(tree, fromFile) || (!normalize(rel).startsWith("..") && (existsExact(tree, rel) || existsExact(tree, normalize(join(pkgDir, rel))) || (e.within !== undefined && existsExact(tree, normalize(join(e.within, rel)))) || abbreviated(tracked(), rel)));
        if (!found) {
          // A path the docs say comes later, or say is gone, can't mislead an agent into using it now.
          const line = lines[e.line - 1] ?? "";
          if (FUTURE.test(line) || GENERATED.test(line) || NOT_COMMITTED.test(line) || NOT_COMMITTED.test(leadIn(lines, e.line - 1)) || uncommitted.has(normalize(rel)) || e.cue === "deleted") continue;
          if (e.elsewhere || e.otherRepo || e.cue === "example" || e.cue === "negated") continue;
          if (madeAnywhere.some((d) => within(normalize(rel), d))) continue;
          // Written in prose, ../x is relative to the reader's working directory, such as a sibling worktree.
          if (e.via !== "link" && normalize(rel).startsWith("..")) continue;
          if (e.via === "code" && (BUILD_OUTPUT.test(normalize(rel)) || MADE_SEGMENT.test(`${normalize(rel)}/`) || PATH_TEMPLATE.test(rel) || HOST.test(rel))) continue;
          // `./jellyfin` is the program the build writes, as a command it would be `built-program`.
          if (e.via === "code" && /^\.\/[\w-]+$/.test(e.text)) continue;
          if (e.via === "code" && !rel.includes("/")) {
            basenames ??= new Set(tracked().map((f) => f.split("/").pop()!));
            if (!basenames.has(rel)) continue;
          }
        }
        // A path written relative to the package it's about, such as a provider's `log/x.py` named in a
        // sibling provider's guide, is found by its tail anywhere in the repo.
        const ok = found || (e.via === "code" && !rel.includes("/")) || (e.via === "code" && packageRelative(tracked(), ".", rel));
        // A README's usage sections describe the user's project, such as Sinatra's `./views`.
        if (!ok && readme && e.via === "code" && !e.headings.some((h) => DEV_HEADING.test(h))) continue;
        const id = `ins-${String(n++).padStart(3, "0")}`;
        items.push({ id, source: file, line: e.line, kind: "path", text: e.text, category: "path", staticResult: ok ? "pass" : "fail", staticReason: ok ? undefined : `${e.text} doesn't exist`, result: ok ? "pass" : "fail", reason: ok ? undefined : `${e.text} doesn't exist`, rule: "path-exists" });
        continue;
      }
      const id = `ins-${String(n++).padStart(3, "0")}`;
      const start = e.within ? (existsExact(tree, normalize(join(fileDir, e.within))) ? normalize(join(fileDir, e.within)) : normalize(e.within)) : pkgDir;
      const base = { id, source: file, line: e.line, kind: "command" as const, text: e.text, cwd: start };
      const skipped = (reason: string, rule: string, staticResult: "pass" | "fail" = "pass", staticReason?: string) => items.push({ ...base, category: "skipped", staticResult, ...(staticReason ? { staticReason } : {}), result: "not_run", reason, rule });
      // A template or a third-party skill's command isn't checked against this repo at all; a real
      // command that asks questions or adds packages still is, statically, before it's skipped.
      if (thirdParty) {
        skipped(`not replayed: it comes from a vendored skill (${thirdParty}), so it documents that tool, not this repo`, "vendored");
        continue;
      }
      if (e.elsewhere) {
        if (PLACEHOLDER.test(e.elsewhere)) skipped(`not replayed: it runs in ${e.elsewhere}, a folder the docs leave to the reader`, "placeholder");
        else skipped(`not checked: it's a step for ${e.elsewhere}, not this repo`, "elsewhere");
        continue;
      }
      if (e.forLockfile && !existsExact(tree, join(start, e.forLockfile)) && !existsExact(tree, e.forLockfile)) {
        skipped(`not checked: the guide gives it for a folder with ${e.forLockfile}, and ${start === "." ? "the root" : start} has none`, "elsewhere");
        continue;
      }
      if (e.cue && e.cue !== "deleted") {
        skipped(CUE_SKIP[e.cue].reason, CUE_SKIP[e.cue].rule);
        continue;
      }
      if (PLACEHOLDER.test(e.text)) {
        const s = skippedReason(e.text, e.within ?? cmdDir)!;
        skipped(s.reason, s.rule);
        continue;
      }
      const s = checkCommand(e.text, { ...ctx, via: e.via }, start);
      const key = `${start}\u0000${e.text}`;
      if (readme && earlier.has(key)) {
        skipped(`not checked again: ${earlier.get(key)} gives the same command`, "duplicate");
        continue;
      }
      if (!readme && !earlier.has(key)) earlier.set(key, `${file}:${e.line}`);
      const section = e.headings.length ? `"${e.headings[e.headings.length - 1]}"` : "its opening section";
      if (readme && !e.headings.some((h) => DEV_HEADING.test(h)) && !s.repo) {
        skipped(`not checked: it reads as usage for the package's users (README.md, under ${section}), not a step for working on this repo`, "consumer", "pass");
        continue;
      }
      if (s.skip) {
        skipped(s.skip, s.rule);
        continue;
      }
      if (s.access) {
        items.push({ ...base, category: "needs_access", staticResult: "pass", result: "not_run", reason: s.access, rule: s.rule });
        continue;
      }
      const skip = isRisky(e.text) ? null : (skippedReason(e.text, e.within ?? cmdDir) ?? (() => {
        const w = writesFiles(e.text, tree, fileDir, profile);
        return w ? { reason: w, rule: "rewrites" } : null;
      })());
      const category = skip ? "skipped" : categorize(e.text, tree, e.within ?? fileDir);
      let result: InstructionItem["result"];
      let reason: string | undefined;
      let rule = s.rule;
      if (s.result === "fail") {
        result = "fail";
        reason = s.reason;
      } else if (skip) {
        result = "not_run";
        reason = skip.reason;
        rule = skip.rule;
      } else if (category === "install") {
        result = "pass";
        reason = "install commands are checked statically; the clean replay runs the frozen install";
        rule = "install-static";
      } else if (category === "risky" || category === "long_running" || category === "needs_access") {
        result = "not_run";
        reason = category === "risky" ? "not replayed: it deploys, publishes, deletes or pipes the network into a shell" : category === "long_running" ? "not replayed: it starts a long-running process" : SUDO.test(e.text) ? "not replayed: it uses sudo" : "not replayed: it refers to a path on the author's machine";
        rule = category === "risky" ? "risky" : category === "long_running" ? "long-running" : SUDO.test(e.text) ? "sudo" : "machine-path";
      } else {
        result = "not_run";
        reason = "waiting for replay";
        rule = "replay";
      }
      items.push({ ...base, category, staticResult: s.result, staticReason: s.reason, result, reason, rule });
    }
  }
  return items;
}

function isText(path: string): boolean {
  try {
    const st = statSync(path);
    if (st.size > 1024 * 1024) return false;
  } catch {
    return false;
  }
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|exe|jar)$/i.test(path);
}

// Tests, fixtures, docs, examples and generated code are full of dummy keys, so a hit there is
// listed for review instead of holding every component below Level 2.
const NOT_SHIPPED: { re: RegExp; where: string }[] = [
  { re: /(^|\/)(tests?|__tests__|specs?|e2e|evals?|fixtures?|__fixtures__|testdata|__mocks__|mocks?|(integration|unit|functional|acceptance|api|e2e)[-_]tests?|tests?[-_](utils?|helpers?|support|setup)|testing)\/|\.(test|spec)\.[\w]+$|_(test|spec)\.\w+$|(^|\/)test_[^/]+$|(^|\/)conftest\.py$/, where: "test" },
  { re: /(^|\/)(generated|__generated__|dist|build|coverage)\/|\.generated\.|\.min\.js$/, where: "generated" },
  { re: /(^|\/)(docs?|examples?|samples?)\/|\.(md|mdx|rst|adoc)$|(^|\/)\.env\.(example|sample|template)$|\.example$/, where: "docs or example" },
];

// A source file that imports a test framework is a test, whatever the repo's naming scheme for
// them (`*.servertest.ts`, `*.e2e.ts`, `check_*.py`).
const TEST_IMPORT = [
  { file: /\.[cm]?[jt]sx?$/, re: /^\s*(?:import\b[^;]*?\bfrom\s*|import\s*|(?:const|let|var)\b[^=]*=\s*require\()\s*["'](?:vitest|@jest\/globals|node:test|mocha|chai|ava|uvu|tap|bun:test|@playwright\/test|@testing-library\/[\w-]+)["']/m },
  { file: /\.py$/, re: /^(?:import\s+(?:pytest|unittest)\b|from\s+(?:pytest|unittest)\b[\w.]*\s+import\b)/m },
];

export function notShipped(file: string, text?: string): string | null {
  const where = NOT_SHIPPED.find((n) => n.re.test(file))?.where ?? null;
  if (where || text === undefined) return where;
  return TEST_IMPORT.some((t) => t.file.test(file) && t.re.test(text)) ? "test" : null;
}

export const SAFETY_RULES: Record<string, string> = {
  secret: "A key or token committed to shipped code blocks Level 2.",
  "secret-not-shipped": "A key or token in tests, fixtures, evals, docs, examples or generated code is listed for review and doesn't block.",
  "secret-example": "A value the vendor documents as an example, such as the access key in AWS's documentation, is listed for review and doesn't block.",
  "secret-no-key": "A private key header with no key after it, as in a comment or a placeholder, is listed for review and doesn't block.",
  "secret-generic": "A value assigned to a name that sounds secret, with no provider's token shape, is listed for review with its name and length and doesn't block: public client keys an app ships, test values and placeholders look the same.",
  "credential-needed": "Tests that read a production credential block Level 2, since agents can't run them without production access.",
  "credential-fixture": "A production credential read in a test fixture, which is test data for the repo's own tests, is listed for review and doesn't block.",
  "network-piped": "An install hook that pipes a download into a shell blocks Level 2; in another script it's listed for review.",
  "lifecycle-hook": "A script that runs on every install is listed for review.",
  destructive: "A script that deletes data is listed for review.",
  "deploy-publish": "A script that deploys or publishes is listed for review.",
  elevated: "A setup step or script that uses sudo is listed for review; the audit runs it only inside a container.",
  "host-mode": "Host mode runs the repo's commands on this machine as this user, so the report says it could read local files; it is never a sandbox.",
  waived: INSTRUCTION_RULES.waived,
};

// Past the scan's time bound, the secret scan stops and records how many files it read; the
// manifest and script checks after it are cheap and always run.
// `blockingSecrets`: the secret classes that block in shipped code, from the rubric's safety block.
export function safetyScan(tree: string, profile: Profile, bound?: ScanBound, blockingSecrets?: readonly SecretClass[]): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  let n = 1;
  const add = (f: Omit<SafetyFinding, "id">) => findings.push({ id: `saf-${String(n++).padStart(3, "0")}`, ...f });
  const files = listFiles(tree, { includeHidden: true });
  if (bound) {
    bound.scope.files = files.length;
    bound.scope.fileCap = files.length >= MAX_FILES ? MAX_FILES : null;
    bound.scope.secrets = { scanned: 0, total: files.length };
  }
  for (const file of files) {
    if (bound && Date.now() > bound.until) break;
    if (bound) bound.scope.secrets.scanned++;
    if (ownSkillPath(file)) continue;
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|bun\.lock)$/.test(file)) continue;
    const full = join(tree, file);
    if (!isText(full)) continue;
    const text = readText(full);
    const where = notShipped(file, text);
    const lines = text.split("\n");
    for (const f of secretFindings(file, text, where, blockingSecrets)) add({ kind: "secret", file, line: f.line, detail: f.detail, blocking: f.blocking, rule: f.rule, secretClass: f.class });
    if (where === "test") {
      const fixture = /(^|\/)(fixtures?|__fixtures__|testdata)\//.test(file);
      lines.forEach((l, i) => {
        const name = [...l.matchAll(ENV_READ)].filter((m) => !insideString(l, m.index!)).map((m) => m[1]).find(prodCredential);
        if (name) add({ kind: "credential_needed", file, line: i + 1, detail: fixture ? `a test fixture reads ${name}, listed for review` : `tests read ${name}`, blocking: !fixture, rule: fixture ? "credential-fixture" : "credential-needed" });
      });
    }
  }
  const env = profile.environmentJson;
  for (const [field, cmd] of [["install", env?.install], ["start", env?.start]] as const) {
    if (cmd && SUDO.test(cmd)) add({ kind: "elevated", file: env!.path, detail: `${field} runs sudo (\`${cmd}\`); the audit runs it only inside a container, never on the host`, blocking: false, rule: "elevated" });
  }
  for (const manifest of profile.manifests.filter((m) => m.endsWith("package.json"))) {
    const pkg = readPackageJson(join(tree, dirname(manifest)));
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
      const hook = /^(pre|post)?install$|^prepare$|^prepublish$/.test(name);
      if (SUDO.test(cmd)) add({ kind: "elevated", file: manifest, detail: `scripts.${name} runs sudo; the audit runs it only inside a container, never on the host`, blocking: false, rule: "elevated" });
      if (NETWORK_PIPED.test(cmd)) add({ kind: "network_piped", file: manifest, detail: `scripts.${name} pipes a download into a shell`, blocking: hook, rule: "network-piped" });
      else if (hook) add({ kind: "lifecycle_hook", file: manifest, detail: `scripts.${name} runs on every install`, blocking: false, rule: "lifecycle-hook" });
      if (DESTRUCTIVE.test(cmd)) add({ kind: "destructive", file: manifest, detail: `scripts.${name} deletes data`, blocking: false, rule: "destructive" });
      if (DEPLOY.test(cmd) || /^(deploy|publish|release)/.test(name)) add({ kind: "deploy_publish", file: manifest, detail: `scripts.${name} deploys or publishes`, blocking: false, rule: "deploy-publish" });
    }
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^(scripts|\.cursor)\/[^/]+\.sh$/.test(f))) {
    if (readText(join(tree, file)).split("\n").some((l) => !l.trim().startsWith("#") && SUDO.test(l))) add({ kind: "elevated", file, detail: "runs sudo; the audit runs it only inside a container, never on the host", blocking: false, rule: "elevated" });
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^scripts\/.+\.sh$/.test(f))) {
    const text = readText(join(tree, file));
    if (DESTRUCTIVE.test(text)) add({ kind: "destructive", file, detail: "contains a command that deletes data", blocking: false, rule: "destructive" });
    if (DEPLOY.test(text) || /deploy|prod/i.test(file)) add({ kind: "deploy_publish", file, detail: "deploys or reaches production", blocking: false, rule: "deploy-publish" });
  }
  return findings;
}
