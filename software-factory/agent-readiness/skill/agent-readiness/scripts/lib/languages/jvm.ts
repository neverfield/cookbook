import { basename, join } from "node:path";
import type { Site } from "../mutate.ts";
import { exists, listFiles, readText } from "../util.ts";
import { inComponent, namedAfter } from "./coverage.ts";
import type { DraftCommand, Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Java, Kotlin and .NET group. Java and Kotlin built with Maven or Gradle are scored;
// an Android build is recognized and not scored.

const OUTPUT = /(^|\/)(target|build|out)\//;

function filesNamed(tree: string, path: string, name: RegExp): string[] {
  return listFiles(join(tree, path)).filter((f) => name.test(basename(f)) && !OUTPUT.test(f));
}

const rel = (path: string, f: string) => (path === "." ? f : `${path}/${f}`);

// A JVM's user.home comes from the passwd entry of the user it runs as, not from $HOME. The audit
// runs as the host's uid, which the image may not know: JDKs before 21 then use "?" and others the
// image's own user, so ~/.m2 and ~/.gradle would land somewhere different on every machine.
export const JVM_HOME = 'JAVA_TOOL_OPTIONS="-Duser.home=$HOME"';

// A version that resolves differently over time: a range such as [1.0,2.0), or LATEST and RELEASE.
const MAVEN_DYNAMIC = /<version>\s*(\[[^<]*|\([^<]*|LATEST|RELEASE)\s*<\/version>/g;

function mavenDynamic(tree: string, path: string): number {
  return filesNamed(tree, path, /^pom\.xml$/).reduce((n, f) => n + [...readText(join(tree, path, f)).matchAll(MAVEN_DYNAMIC)].length, 0);
}

const mvnOf = (tree: string, path: string) => `${JVM_HOME} ${exists(join(tree, path, "mvnw")) ? "./mvnw" : "mvn"}`;
const gradleOf = (tree: string, path: string) => `${JVM_HOME} ${exists(join(tree, path, "gradlew")) ? "./gradlew" : "gradle"}`;

const maven: Ecosystem = {
  id: "maven",
  label: "Maven",
  lockfiles: [],
  rule: "`mvn dependency:go-offline` through the committed Maven Wrapper when there is one, with every dependency and plugin version fixed in `pom.xml`: no version ranges, `LATEST` or `RELEASE`",
  install: (tree, path) => {
    const fixed = mavenDynamic(tree, path) === 0;
    return { command: `${mvnOf(tree, path)} -B -q dependency:go-offline`, reason: fixed ? "resolves the versions pom.xml fixes" : "pom.xml leaves some versions open, so the install can't be frozen", frozen: fixed };
  },
  unpinned: (tree, path) => {
    const n = mavenDynamic(tree, path);
    return n ? `pom.xml leaves ${n} ${n === 1 ? "version" : "versions"} open (a range, LATEST or RELEASE)` : null;
  },
};

// A dynamic Gradle version: `1.+`, `latest.release`, or a range.
const GRADLE_DYNAMIC = /["'][\w.-]+:[\w.-]+:(\d[\w.]*\.\+|\+|latest\.[a-z]+|[[(][^"']*)["']/g;

function gradleLocked(tree: string, path: string): boolean {
  return filesNamed(tree, path, /^gradle\.lockfile$/).length > 0;
}

function gradleDynamic(tree: string, path: string): number {
  return filesNamed(tree, path, /^(build\.gradle(\.kts)?|libs\.versions\.toml)$/).reduce((n, f) => n + [...readText(join(tree, path, f)).matchAll(GRADLE_DYNAMIC)].length, 0);
}

// `gradle dependencies` resolves the dependency graph without downloading a jar, so the offline test
// run would find nothing cached. This init script downloads every resolvable configuration's files.
const RESOLVE_ALL = "gradle.projectsEvaluated { g -> g.rootProject.allprojects { p -> p.configurations.matching { it.canBeResolved }.each { c -> try { c.incoming.artifactView { lenient(true) }.files.files } catch (e) { } } } }";
const RESOLVE_SCRIPT = '"$HOME/readiness-resolve.gradle"';

const gradle: Ecosystem = {
  id: "gradle",
  label: "Gradle",
  lockfiles: ["gradle.lockfile"],
  rule: "every resolvable configuration's dependencies downloaded through the committed Gradle Wrapper, with dependency locking (`gradle.lockfile`) committed, or with no dynamic versions (`1.+`, `latest.release`, ranges) in the build",
  install: (tree, path) => {
    const fixed = gradleLocked(tree, path) || gradleDynamic(tree, path) === 0;
    return {
      command: `printf '%s\\n' '${RESOLVE_ALL}' > ${RESOLVE_SCRIPT} && ${gradleOf(tree, path)} --no-daemon -q -I ${RESOLVE_SCRIPT} help`,
      reason: fixed ? "downloads the versions the build fixes or locks, for every configuration" : "the build uses dynamic versions and commits no gradle.lockfile, so the install can't be frozen",
      frozen: fixed,
    };
  },
  unpinned: (tree, path) => {
    if (gradleLocked(tree, path)) return null;
    const n = gradleDynamic(tree, path);
    return n ? `the Gradle build uses ${n} dynamic ${n === 1 ? "version" : "versions"} and commits no gradle.lockfile` : null;
  },
};

// The Android Gradle Plugin, applied by id, by version catalog alias, or put on the buildscript classpath.
const ANDROID = /\bcom\.android\.(application|library|dynamic-feature|test)\b|com\.android\.tools\.build:gradle\b|\blibs\.plugins\.android\.(application|library)\b|^\s*android\s*\{/m;

// The JDK lines the audit has an image for: the LTS releases.
export const JDKS = [8, 11, 17, 21, 25];
const DEFAULT_JDK = 21;

const BUILD_SCRIPT = /\.gradle(\.kts)?$/;
const VERSION_FILES = [".java-version", ".sdkmanrc", ".tool-versions"];

const GRADLE_TOOLCHAIN = [/JavaLanguageVersion\.of\(\s*(\d+)/g, /jvmToolchain\(\s*(\d+)/g];
const GRADLE_TARGET = [
  /JavaVersion\.VERSION_(?:1_)?(\d+)/g,
  /(?:source|target)Compatibility\s*=\s*['"]?(?:1\.)?(\d+)/g,
  /JvmTarget\.JVM_(?:1_)?(\d+)/g,
  /jvmTarget\s*=\s*["'](?:1\.)?(\d+)/g,
  /options\.release(?:\.set)?\s*[=(]\s*(\d+)/g,
];
const MAVEN_TARGET = [/<maven\.compiler\.(?:release|source|target)>\s*(?:1\.)?(\d+)/g, /<(?:release|source)>\s*(?:1\.)?(\d+)\s*<\//g, /<java\.version>\s*(?:1\.)?(\d+)/g];

function numbers(text: string, res: RegExp[]): number[] {
  return res.flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1]))).filter((n) => n >= 6 && n <= 40);
}

// The Java version a version manager file names: `21`, `1.8`, `java=21.0.2-tem`, `java temurin-17.0.9`.
function versionFileJdk(file: string, text: string): number | null {
  const line = file.endsWith(".java-version") ? text.trim() : text.match(/^java[=\s]+\s*(\S+)/m)?.[1];
  const m = line?.match(/(?:^|[-_])(?:1\.)?(\d+)(?:[.+\-_]|$)/);
  return m ? Number(m[1]) : null;
}

interface JdkPin {
  version: number;
  file: string;
  // A Gradle toolchain needs that exact JDK; a release or compatibility level runs on any newer one.
  toolchain: boolean;
}

function jdkPin(tree: string, path: string): JdkPin | null {
  for (const dir of [path, "."]) {
    for (const f of VERSION_FILES) {
      const file = join(tree, dir, f);
      const v = exists(file) ? versionFileJdk(f, readText(file)) : null;
      if (v) return { version: v, file: rel(dir, f), toolchain: false };
    }
  }
  // A toolchain beats a release level, and a higher version beats a lower one of the same kind.
  const found: JdkPin[] = [];
  for (const f of filesNamed(tree, path, BUILD_SCRIPT)) {
    const text = readText(join(tree, path, f));
    for (const v of numbers(text, GRADLE_TOOLCHAIN)) found.push({ version: v, file: rel(path, f), toolchain: true });
    for (const v of numbers(text, GRADLE_TARGET)) found.push({ version: v, file: rel(path, f), toolchain: false });
  }
  for (const f of filesNamed(tree, path, /^pom\.xml$/)) for (const v of numbers(readText(join(tree, path, f)), MAVEN_TARGET)) found.push({ version: v, file: rel(path, f), toolchain: false });
  return found.sort((a, b) => Number(b.toolchain) - Number(a.toolchain) || b.version - a.version || a.file.localeCompare(b.file))[0] ?? null;
}

function wrapperGradle(tree: string, path: string): [number, number] | null {
  const props = join(tree, path, "gradle", "wrapper", "gradle-wrapper.properties");
  const m = exists(props) ? readText(props).match(/gradle-(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// The newest JDK line a Gradle release runs on, and the oldest: Gradle 9 needs Java 17 to run.
function gradleRunsOn([major, minor]: [number, number]): { min: number; max: number } {
  const at = (a: number, b: number) => major > a || (major === a && minor >= b);
  const max = at(9, 1) ? 25 : at(8, 5) ? 21 : at(7, 3) ? 17 : at(5, 0) ? 11 : 8;
  return { min: major >= 9 ? 17 : 8, max };
}

// The JDK line a component runs on: the pinned version, or the next LTS above it, within what the
// committed Gradle Wrapper can run on.
export function jdkFor(tree: string, path: string): number {
  const pin = jdkPin(tree, path);
  const want = pin?.version ?? DEFAULT_JDK;
  let jdk = JDKS.find((v) => v >= want) ?? JDKS[JDKS.length - 1];
  const wrapper = wrapperGradle(tree, path);
  if (wrapper) {
    const runs = gradleRunsOn(wrapper);
    if (jdk > runs.max) jdk = [...JDKS].reverse().find((v) => v <= runs.max) ?? JDKS[0];
    if (jdk < runs.min) jdk = JDKS.find((v) => v >= runs.min)!;
  }
  return jdk;
}

const isMaven = (tree: string, path: string) => exists(join(tree, path, "pom.xml"));

function multiplatform(tree: string, path: string): boolean {
  return filesNamed(tree, path, /^build\.gradle(\.kts)?$/).some((f) => /kotlin\("multiplatform"\)|org\.jetbrains\.kotlin\.multiplatform|kotlin-multiplatform/.test(readText(join(tree, path, f))));
}

function buildText(tree: string, path: string): string {
  return filesNamed(tree, path, /^(pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml)$|\.gradle(\.kts)?$/).map((f) => readText(join(tree, path, f))).join("\n");
}

// The lint tasks the build declares a plugin for. The audit doesn't add a linter a repo doesn't use.
// Maven's Checkstyle is left out: its rules usually sit in an execution, so `checkstyle:check` from
// the command line would run Sun's defaults instead of the repo's.
function lintTasks(tree: string, path: string, maven: boolean): string[] {
  const text = buildText(tree, path);
  if (maven) return /spotless-maven-plugin/.test(text) ? ["spotless:check"] : [];
  const tasks: string[] = [];
  if (/com\.diffplug\.spotless|plugins\.spotless\b/.test(text)) tasks.push("spotlessCheck");
  if (/org\.jlleitschuh\.gradle\.ktlint|plugins\.ktlint\b/.test(text)) tasks.push("ktlintCheck");
  if (/io\.gitlab\.arturbosch\.detekt|plugins\.detekt\b/.test(text)) tasks.push("detekt");
  if (/^\s*(id\s*\(?\s*["']checkstyle["']|checkstyle\b\s*$|apply plugin:\s*['"]checkstyle['"])/m.test(text)) tasks.push("checkstyleMain");
  return tasks;
}

// Surefire's total for a module has no "Time elapsed" after it; Gradle prints a total only when a test fails.
export function jvmTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const surefire = [...text.matchAll(/^\[(?:INFO|WARNING|ERROR)\]\s+Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)];
  if (surefire.length) {
    let run = 0;
    let failed = 0;
    let skipped = 0;
    for (const m of surefire) {
      run += Number(m[1]);
      failed += Number(m[2]) + Number(m[3]);
      skipped += Number(m[4]);
    }
    return { passed: run - skipped - failed, failed, total: run - skipped };
  }
  const gradleRuns = [...text.matchAll(/^(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/gm)];
  if (gradleRuns.length) {
    let total = 0;
    let failed = 0;
    for (const m of gradleRuns) {
      total += Number(m[1]) - Number(m[3] ?? 0);
      failed += Number(m[2]);
    }
    return { passed: total - failed, failed, total };
  }
  return null;
}

// --- Fault sites for C-family languages whose `if` takes parentheses: Java, Kotlin and C#. -----

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const NOT_CODE = /^(\/\/|\/\*|\*|@|#|import\s|package\s|using\s|namespace\s)/;
const TIMING = /(setTimeout|sleep|delay|timeout|debounce|throttle|interval|backoff|\bttl\b|maxAge|expires?\b|Duration\.|TimeUnit\.|millis|seconds)/i;

// Whether `index` falls inside a string or char literal that opens and closes on this line.
function insideLiteral(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "/" && line[i + 1] === "/") return true;
  }
  return quote !== null;
}

function firstCode(line: string, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = g.exec(line); m; m = g.exec(line)) if (!insideLiteral(line, m.index)) return m;
  return null;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

// The faults a line can take, each still valid code. `semicolons` is false for Kotlin, where a
// dropped throw becomes `Unit` rather than an empty statement.
export function cLikeSites(line: string, semicolons: boolean): Omit<Site, "file" | "line">[] {
  const trimmed = line.trim();
  if (!trimmed || NOT_CODE.test(trimmed)) return [];
  const out: Omit<Site, "file" | "line">[] = [];
  const b = firstCode(line, / (<=|>=|<|>) /);
  if (b) out.push({ operator: "boundary_flip", before: line, after: line.slice(0, b.index) + ` ${BOUNDARY[b[1]]} ` + line.slice(b.index + b[0].length) });
  const cond = firstCode(line, /\b(if|while) \(/);
  if (cond) {
    const start = cond.index + cond[0].length;
    let depth = 1;
    let i = start;
    for (; i < line.length && depth > 0; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
    }
    if (depth === 0) out.push({ operator: "negate_condition", before: line, after: line.slice(0, start) + `!(${line.slice(start, i - 1)})` + line.slice(i - 1) });
  }
  const s = firstCode(line, / ([+-]) 1(?![\d.\w])/);
  if (s) out.push({ operator: "shift_by_one", before: line, after: line.slice(0, s.index) + ` ${s[1] === "+" ? "-" : "+"} 1` + line.slice(s.index + s[0].length) });
  const r = firstCode(line, /\breturn (true|false)\b/);
  if (r) out.push({ operator: "swap_return", before: line, after: line.slice(0, r.index) + `return ${r[1] === "true" ? "false" : "true"}` + line.slice(r.index + r[0].length) });
  const indent = line.match(/^\s*/)?.[0] ?? "";
  if (semicolons ? /^(throw\b.*|return);\s*$/.test(trimmed) && balanced(trimmed) : /^(throw\b.*\)|return)\s*$/.test(trimmed) && balanced(trimmed)) {
    out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}${semicolons ? ";" : "Unit"}` });
  }
  const c = firstCode(line, /(?<![\w.$])(\d+)(?![\w.])/);
  if (c && !/^\s*(case\b|default\b)/.test(line) && !TIMING.test(line)) {
    const n = Number(c[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: line.slice(0, c.index) + String(n + 1) + line.slice(c.index + c[0].length) });
  }
  return out.filter((x) => x.after !== x.before);
}

// 0-based lines inside a block comment or a string that spans lines: Java text blocks and Kotlin
// raw strings (`"""`), and with `verbatim` C#'s `@"..."` strings too.
export function cLikeQuoted(text: string, verbatim: boolean): Set<number> {
  const out = new Set<number>();
  let line = 0;
  let state: "code" | "line" | "block" | "triple" | "verbatim" | "string" | "char" = "code";
  let from = 0;
  const close = () => {
    if (line !== from) for (let l = from; l <= line; l++) out.add(l);
    state = "code";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      if (state === "line" || state === "string" || state === "char") state = "code";
      line++;
      continue;
    }
    switch (state) {
      case "code":
        if (ch === "/" && text[i + 1] === "/") state = "line";
        else if (ch === "/" && text[i + 1] === "*") {
          state = "block";
          from = line;
          i++;
        } else if (text.startsWith('"""', i)) {
          state = "triple";
          from = line;
          i += 2;
        } else if (verbatim && ch === "@" && text[i + 1] === '"') {
          state = "verbatim";
          from = line;
          i++;
        } else if (ch === '"') state = "string";
        else if (ch === "'") state = "char";
        break;
      case "block":
        if (ch === "*" && text[i + 1] === "/") {
          i++;
          close();
        }
        break;
      case "triple":
        if (text.startsWith('"""', i)) {
          i += 2;
          close();
        }
        break;
      case "verbatim":
        if (ch === '"' && text[i + 1] === '"') i++;
        else if (ch === '"') close();
        break;
      case "string":
      case "char":
        if (ch === "\\") i++;
        else if ((state === "string" && ch === '"') || (state === "char" && ch === "'")) state = "code";
        break;
      case "line":
        break;
      default: {
        const never: never = state;
        throw new Error(`unknown scanner state ${never}`);
      }
    }
  }
  return out;
}

// --- Replay hooks ------------------------------------------------------------------------------

const JVM_SOURCE = /\.(java|kt)$/;
const TEST_DIR = /(^|\/)src\/\w*[tT]est\w*\//;
const TEST_NAME = /(Test|Tests|IT|Spec)\.(java|kt)$/;
const isTest = (f: string) => JVM_SOURCE.test(f) && (TEST_DIR.test(f) || TEST_NAME.test(f));
const isSource = (f: string) => JVM_SOURCE.test(f) && !isTest(f) && !OUTPUT.test(f) && !/(^|\/)(generated[\w-]*|buildSrc|build-logic)\//.test(f) && !/(package|module)-info\.java$/.test(f);

function temurin(jdk: number): string {
  return `eclipse-temurin:${jdk}-jdk`;
}

// The wrapper fetches its own Maven or Gradle, so a project with one runs on the plain JDK. Without
// one, the build tool's own image supplies it: Gradle 9 runs on Java 17 or later only.
function imageFor(tree: string, path: string): string {
  const jdk = jdkFor(tree, path);
  if (isMaven(tree, path)) return exists(join(tree, path, "mvnw")) ? temurin(jdk) : `maven:3.9-eclipse-temurin-${jdk}`;
  if (exists(join(tree, path, "gradlew"))) return temurin(jdk);
  return jdk >= 17 ? `gradle:9-jdk${jdk}` : `gradle:8-jdk${jdk}`;
}

function jvmCommands(tree: string, path: string): DraftCommand[] {
  const out: DraftCommand[] = [];
  if (isMaven(tree, path)) {
    const mvn = mvnOf(tree, path);
    const source = "pom.xml";
    const lint = lintTasks(tree, path, true);
    if (lint.length) out.push({ kind: "lint", command: `${mvn} -B -ntp ${lint.join(" ")}`, source, reason: `the lint plugins pom.xml declares (${lint.join(", ")})` });
    // Surefire resolves its test provider only when it runs, which dependency:go-offline misses. A
    // filter that matches every class and no method loads the provider while the network is on and
    // runs no test.
    out.push({ kind: "build", command: `${mvn} -B -ntp package '-Dtest=*#readinessNoTest' -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false`, source, reason: "Maven's package phase, with Surefire's test provider loaded and no test run" });
    out.push({ kind: "test", command: `${mvn} -B -ntp -o test`, source, reason: "Maven's test phase, offline" });
    return out;
  }
  const gw = gradleOf(tree, path);
  const source = exists(join(tree, path, "build.gradle.kts")) ? "build.gradle.kts" : "build.gradle";
  const lint = lintTasks(tree, path, false);
  if (lint.length) out.push({ kind: "lint", command: `${gw} --no-daemon ${lint.join(" ")}`, source, reason: `the lint plugins the build applies (${lint.join(", ")})` });
  out.push({ kind: "build", command: `${gw} --no-daemon assemble`, source, reason: "Gradle's assemble task" });
  const kmp = multiplatform(tree, path);
  out.push({ kind: "test", command: `${gw} --no-daemon --offline ${kmp ? "jvmTest" : "test"}`, source, reason: kmp ? "the JVM target's tests of a multiplatform build, offline" : "Gradle's test task, offline" });
  return out;
}

// Faults go only in main sources, so compiling them is enough. The probe gets no tree, so it uses
// the wrapper when the folder has one when it runs.
function compileProbe(pm: string | null | undefined): string {
  const run = (wrapper: string, tool: string) => `${JVM_HOME} $([ -x ./${wrapper} ] && echo ./${wrapper} || echo ${tool})`;
  if (pm === "maven") return `${run("mvnw", "mvn")} -B -ntp -o -q compile`;
  return `${run("gradlew", "gradle")} --no-daemon --offline -q classes`;
}

const IMAGES: Record<string, string> = {
  "eclipse-temurin:8-jdk": "sha256:c424f46b825d495a28e8f26ca5f411585119e5d9bd9152521180b9d5e5a303c4",
  "eclipse-temurin:11-jdk": "sha256:8b64035b610d11979ee0fdefca06355b8fcfb7001ec657a5223ca996b82614b4",
  "eclipse-temurin:17-jdk": "sha256:5465815640e10433422217335e15a523a3e57021a1f2ae0fc3849380d237979f",
  "eclipse-temurin:21-jdk": "sha256:0a3f329821dcadf54b2a3033a15e2e9f007069a9db43d7f51897e6b80e726b07",
  "eclipse-temurin:25-jdk": "sha256:b8705e936964c228dfce359e63dbf08f6c69cb380ed1d576b1f6b1064f15567d",
  "maven:3.9-eclipse-temurin-8": "sha256:0f402712b7a469189cfea5ec69cdcadcb32b22aaf1ea62777ab925c3d8470175",
  "maven:3.9-eclipse-temurin-11": "sha256:7bb84a451705605a47d24eb844d4d9ab03e33e131a507db76aafe25db3907f64",
  "maven:3.9-eclipse-temurin-17": "sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584",
  "maven:3.9-eclipse-temurin-21": "sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320",
  "maven:3.9-eclipse-temurin-25": "sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976",
  "gradle:8-jdk8": "sha256:1cabc8045a1037d2c584ec8d035bdca4292fb2d46bb12a71422b1659f983f5ae",
  "gradle:8-jdk11": "sha256:270ea41332ef30582ef5f36ef23b4bc8860e52c83a8d5b782584362275ac8bef",
  "gradle:9-jdk17": "sha256:1b8675f710da5ad837e711758886dc63524877a3efa9ee96ffd2e4f6fef07211",
  "gradle:9-jdk21": "sha256:607055593f1acc874a98aa7c1cb5adb414b3879bb0a5e1e7240180020fb97277",
  "gradle:9-jdk25": "sha256:39d599d8df1777d73b00b5bf928254ecd121802d518577fe08d41a3cf86aa45f",
};

export const jvm: LanguageDef = {
  id: "jvm",
  label: "JVM",
  codes: ["java", "kotlin"],
  stacks: [
    { id: "jvm", label: "Java or Kotlin on the JVM", kind: "stack", tier: "supported", files: /\.(java|kt|kts|scala|gradle)$|(^|\/)pom\.xml$/, proof: ["fixtures/java-maven", "fixtures/kotlin-gradle", "spring-projects/spring-petclinic@500158f", "mockito/mockito-kotlin@5969d27"] },
    {
      id: "android",
      label: "Android",
      kind: "stack",
      tier: "not_assessed",
      reason: "the audit recognizes a Gradle build that applies the Android plugin and doesn't score it in this release, since it needs the Android SDK, which none of the audit's images ships",
      proof: ["fixtures/android-gradle"],
    },
  ],
  detect: {
    manifests: [{ match: /^(pom\.xml|build\.gradle(\.kts)?)$/, stack: "jvm", rank: 40 }],
    sources: [{ ext: /\.(java|kt|scala)$/, stack: "jvm", rank: 40 }],
    rootApp: { names: ["pom.xml", "build.gradle", "build.gradle.kts"], stack: "jvm", toolchain: "JVM", suffix: "jvm", rank: 50 },
    lockfiles: ["gradle.lockfile"],
    projectName: (tree, manifest, text) => {
      // The project's own artifactId, not its parent's, such as spring-boot-starter-parent.
      if (manifest === "pom.xml") return text.replace(/<parent>[\s\S]*?<\/parent>/, "").match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
      if (!/^build\.gradle(\.kts)?$/.test(manifest)) return undefined;
      const settings = ["settings.gradle.kts", "settings.gradle"].map((f) => join(tree, f)).find(exists);
      return settings ? readText(settings).match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1] : undefined;
    },
    refine: (manifest, text) => (/build\.gradle(\.kts)?$/.test(manifest) && ANDROID.test(text) ? "android" : undefined),
  },
  ecosystems: [maven, gradle],
  replay: {
    classify: (tree, dir, manifest) => {
      const sources = listFiles(join(tree, dir)).filter((f) => !OUTPUT.test(f));
      const kt = sources.filter((f) => f.endsWith(".kt")).length;
      const java = sources.filter((f) => f.endsWith(".java")).length;
      return { language: kt > java ? "kotlin" : "java", packageManager: basename(manifest) === "pom.xml" ? "maven" : "gradle" };
    },
    image: imageFor,
    images: IMAGES,
    doctor: "java -version",
    pins: (tree, dir) => {
      const found: string[] = [];
      const missing: string[] = [];
      const pin = jdkPin(tree, dir);
      if (pin) found.push(pin.file);
      else missing.push("the Java version (.java-version, or the release or toolchain the build sets)");
      if (isMaven(tree, dir)) {
        const props = rel(dir, ".mvn/wrapper/maven-wrapper.properties");
        if (exists(join(tree, props)) && exists(join(tree, dir, "mvnw"))) found.push(props);
        else missing.push("the Maven version (a committed Maven Wrapper, mvnw and .mvn/wrapper/maven-wrapper.properties)");
      } else {
        const props = rel(dir, "gradle/wrapper/gradle-wrapper.properties");
        if (exists(join(tree, props)) && exists(join(tree, dir, "gradlew"))) found.push(props);
        else missing.push("the Gradle version (a committed Gradle Wrapper, gradlew and gradle/wrapper/gradle-wrapper.properties)");
      }
      return { found, missing };
    },
    commands: (tree, comp) => jvmCommands(tree, comp.path),
    testCounts: jvmTestCounts,
    budget: { commandTimeoutSec: 1200, componentMinutes: 45, mutationRunTimeoutSec: 900 },
    mutation: {
      isTest,
      isSource,
      covered: (_tree, _comp, tests, files) => namedAfter(tests, files, isSource),
      sites: (line) => cLikeSites(line, true),
      quoted: (text) => cLikeQuoted(text, false),
      compileProbe: (comp) => ({ command: compileProbe(comp.packageManager), cwd: comp.path }),
      compileError: (output) => /COMPILATION ERROR|Compilation failure|Compilation failed|\.java:\d+: error:|^e: (file:\/\/)?\/|Compilation error\. See log/m.test(output),
    },
  },
};
