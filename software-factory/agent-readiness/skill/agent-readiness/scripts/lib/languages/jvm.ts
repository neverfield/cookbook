import { basename, join } from "node:path";
import type { Site } from "../mutate.ts";
import { clip, exists, listFiles, readText } from "../util.ts";
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
    return { command: `${mvnOf(tree, path)} -B -ntp dependency:go-offline`, reason: fixed ? "resolves the versions pom.xml fixes" : "pom.xml leaves some versions open, so the install can't be frozen", frozen: fixed };
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

// `gradle dependencies` resolves the dependency graph without downloading a jar, and exits 0 when a
// dependency can't be resolved, so the offline test run would find nothing cached. This init script
// downloads every resolvable configuration's files and fails on the first dependency it couldn't
// resolve, so a blocked registry's "Could not GET" reaches the diagnosis. A configuration no variant
// matches is a build's own choice, not a missing dependency, and is left alone: Gradle reports it as
// "Could not resolve x" with the variant error as its cause, so the whole cause chain is read (moshi's
// Dokka configurations). A configuration deprecated for resolution, or one that throws, is skipped. An
// included build is resolved before the composite substitutes the root build's projects for its
// dependencies (mockito-kotlin's tests build depends on mockito-kotlin itself), so there only a failed
// registry request fails.
const RESOLVE_ALL = "gradle.projectsEvaluated { g -> def chain = { t -> def s = []; while (t) { s << (t.message ?: \"\"); t = t.cause }; s.join(\" \") }; def bad = []; g.rootProject.allprojects { p -> p.configurations.matching { it.canBeResolved && !(it.respondsTo(\"isDeprecatedForResolution\") && it.isDeprecatedForResolution()) }.each { c -> try { def a = c.incoming.artifactView { lenient(true) }.artifacts; a.artifactFiles.files; a.failures.findAll { f -> def why = chain(f); !(why =~ /Cannot choose between|No matching variant|No matching configuration|No variants of/) && (g.parent == null || why =~ /Could not (GET|HEAD) /) }.each { bad << it } } catch (e) { } } }; if (bad) throw bad[0] }";
const RESOLVE_SCRIPT = '"$HOME/readiness-resolve.gradle"';

const gradle: Ecosystem = {
  id: "gradle",
  label: "Gradle",
  lockfiles: ["gradle.lockfile"],
  rule: "every resolvable configuration's dependencies downloaded through the committed Gradle Wrapper, failing on any it can't resolve, with dependency locking (`gradle.lockfile`) committed, or with no dynamic versions (`1.+`, `latest.release`, ranges) in the build",
  install: (tree, path) => {
    const fixed = gradleLocked(tree, path) || gradleDynamic(tree, path) === 0;
    return {
      command: `printf '%s\\n' '${RESOLVE_ALL}' > ${RESOLVE_SCRIPT} && ${gradleOf(tree, path)} --no-daemon -I ${RESOLVE_SCRIPT} help`,
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

const GRADLE_TOOLCHAIN = [/JavaLanguageVersion\.of\s*\(?\s*["']?(\d+)/g, /jvmToolchain\s*\(\s*["']?(\d+)/g];
// A toolchain whose version comes from the version catalog, as moshi's
// `toolchain { languageVersion.set(libs.versions.jdk.map(JavaLanguageVersion::of)) }` or
// `jvmToolchain(libs.versions.jdk.get().toInt())`.
const GRADLE_CATALOG_TOOLCHAIN = /(?:JavaLanguageVersion|jvmToolchain|languageVersion)\b[^\n]*?\blibs\.versions\.([\w.]+?)\.(?:get|map)\b/g;

// The [versions] table of the Gradle version catalog, keyed by its accessor (`java-toolchain` is
// `libs.versions.java.toolchain`).
function catalogVersions(tree: string, path: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = [path, "."].map((d) => join(tree, d, "gradle", "libs.versions.toml")).find(exists);
  if (!file) return out;
  let inVersions = false;
  for (const line of readText(file).split("\n")) {
    const table = line.match(/^\s*\[([^\]]+)\]/);
    if (table) inVersions = table[1].trim() === "versions";
    const kv = inVersions && !table ? line.match(/^\s*([\w.-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*?(?:strictly|require|prefer)\s*=\s*"([^"]*)")/) : null;
    if (kv) out.set(kv[1].replace(/[-_]/g, "."), kv[2] ?? kv[3]);
  }
  return out;
}

function catalogToolchains(text: string, catalog: Map<string, string>): number[] {
  return [...text.matchAll(GRADLE_CATALOG_TOOLCHAIN)]
    .map((m) => catalog.get(m[1])?.match(/^(?:1\.)?(\d+)/)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .filter((n) => n >= 6 && n <= 40);
}
const GRADLE_TARGET = [
  /JavaVersion\.VERSION_(?:1_)?(\d+)/g,
  /(?:source|target)Compatibility\s*=\s*['"]?(?:1\.)?(\d+)/g,
  /JvmTarget\.JVM_(?:1_)?(\d+)/g,
  /jvmTarget\s*=\s*["'](?:1\.)?(\d+)/g,
  /options\.release(?:\.set)?\s*[=(]\s*(\d+)/g,
];
const MAVEN_TARGET = [/<maven\.compiler\.(?:release|source|target|testRelease|testSource|testTarget)>\s*(?:1\.)?(\d+)/g, /<(?:release|source|testRelease)>\s*(?:1\.)?(\d+)\s*<\//g, /<java\.version>\s*(?:1\.)?(\d+)/g];

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
  const catalog = catalogVersions(tree, path);
  for (const f of filesNamed(tree, path, BUILD_SCRIPT)) {
    const text = readText(join(tree, path, f));
    for (const v of [...numbers(text, GRADLE_TOOLCHAIN), ...catalogToolchains(text, catalog)]) found.push({ version: v, file: rel(path, f), toolchain: true });
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

// The Java versions a Maven Enforcer requireJavaVersion rule allows, such as gson's [17,26): the
// build refuses to start on any other JDK, whatever release it compiles for. A bare version is a
// minimum. Majors only, with 1.8 read as 8.
export function enforcedJava(tree: string, path: string): { min: number | null; max: number | null } | null {
  const major = (v: string) => {
    const m = v.trim().match(/^(?:1\.)?(\d+)/);
    return m ? Number(m[1]) : null;
  };
  for (const f of filesNamed(tree, path, /^pom\.xml$/)) {
    const spec = readText(join(tree, path, f)).match(/<requireJavaVersion>[\s\S]*?<version>\s*([^<]+?)\s*<\/version>/)?.[1];
    if (!spec) continue;
    const range = spec.match(/^([[(])\s*([^,]*?)\s*,\s*([^\])]*?)\s*([\])])/);
    if (!range) return { min: major(spec), max: null };
    const lo = range[2] ? major(range[2]) : null;
    const hi = range[3] ? major(range[3]) : null;
    return { min: lo === null ? null : range[1] === "(" ? lo + 1 : lo, max: hi === null ? null : range[4] === ")" ? hi - 1 : hi };
  }
  return null;
}

// The JDK line a component runs on: the pinned version, or the next LTS above it, within what a
// Maven Enforcer rule allows and what the committed Gradle Wrapper can run on.
export function jdkFor(tree: string, path: string): number {
  const pin = jdkPin(tree, path);
  const enforced = enforcedJava(tree, path);
  const want = Math.max(pin?.version ?? DEFAULT_JDK, enforced?.min ?? 0);
  let jdk = JDKS.find((v) => v >= want) ?? JDKS[JDKS.length - 1];
  const floor = Math.max(pin?.version ?? 0, enforced?.min ?? 0);
  if (enforced?.max != null && jdk > enforced.max) jdk = [...JDKS].reverse().find((v) => v <= enforced.max! && v >= floor) ?? jdk;
  const wrapper = wrapperGradle(tree, path);
  if (wrapper) {
    const runs = gradleRunsOn(wrapper);
    if (jdk > runs.max) jdk = [...JDKS].reverse().find((v) => v <= runs.max) ?? JDKS[0];
    if (jdk < runs.min) jdk = JDKS.find((v) => v >= runs.min)!;
  }
  return jdk;
}

// The JDK a Maven Toolchains requirement needs that the image's own doesn't satisfy: an exact major
// for a bare version, else the lowest LTS inside the range. Null when the image's JDK will do.
function mavenToolchainJdk(spec: string, main: number): number | null {
  const major = (v: string) => {
    const m = v.trim().match(/^(?:1\.)?(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const range = spec.match(/^([[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])$/);
  if (!range) return major(spec);
  const lo = range[2] ? major(range[2]) : null;
  if (range[3] === undefined) return lo;
  const min = lo === null ? 0 : range[1] === "(" ? lo + 1 : lo;
  const hiRaw = range[3] ? major(range[3]) : null;
  const max = hiRaw === null ? Infinity : range[4] === ")" ? hiRaw - 1 : hiRaw;
  if (main >= min && main <= max) return null;
  return JDKS.find((v) => v >= min && v <= max) ?? null;
}

// A JDK a Maven Toolchains plugin or Surefire's jdkToolchain asks for.
const MAVEN_TOOLCHAIN = /<(?:jdkToolchain|toolchains>\s*<jdk)>(?:(?!<\/jdk(?:Toolchain)?>)[\s\S])*?<version>\s*([^<]+?)\s*<\/version>/g;

// Every JDK the build's toolchains ask for beyond the one the image ships, with the file that first
// asks for it. A Gradle toolchain needs that exact JDK, and Gradle can't download one with the network
// off: moshi's records-tests asks for 17 next to the root's 21. JDKs the audit has no image for
// (non-LTS lines) are left out.
export function extraJdks(tree: string, path: string): { version: number; file: string; reason: string }[] {
  const main = jdkFor(tree, path);
  const out: { version: number; file: string; reason: string }[] = [];
  const add = (version: number | null, file: string, reason: string) => {
    if (version === null || version === main || !JDKS.includes(version) || out.some((o) => o.version === version)) return;
    out.push({ version, file, reason });
  };
  const catalog = catalogVersions(tree, path);
  for (const f of filesNamed(tree, path, BUILD_SCRIPT).sort()) {
    const text = readText(join(tree, path, f));
    for (const v of [...numbers(text, GRADLE_TOOLCHAIN), ...catalogToolchains(text, catalog)]) add(v, rel(path, f), `${rel(path, f)} asks for a Java ${v} toolchain`);
  }
  for (const f of filesNamed(tree, path, /^pom\.xml$/).sort()) {
    const text = readText(join(tree, path, f)).replace(/<!--[\s\S]*?-->/g, "");
    for (const m of text.matchAll(MAVEN_TOOLCHAIN)) {
      const v = mavenToolchainJdk(m[1], main);
      add(v, rel(path, f), `${rel(path, f)} asks Maven Toolchains for JDK ${m[1]}`);
    }
  }
  return out.sort((a, b) => a.version - b.version);
}

const JDK_COPIES = "/usr/lib/jvm/readiness-jdk-";

// Registers every copied JDK, for Gradle in the Gradle user home's gradle.properties and for Maven in
// ~/.m2/toolchains.xml next to the image's own JDK, which Maven Toolchains doesn't find on its own.
// /usr/lib/jvm is also where Gradle's auto-detection looks on Linux.
export function registerJdks(home: string): string {
  const entry = `echo "  <toolchain><type>jdk</type><provides><version>$v</version></provides><configuration><jdkHome>$d</jdkHome></configuration></toolchain>"`;
  return [
    `g="\${GRADLE_USER_HOME:-${home}/.gradle}"`,
    `mkdir -p "$g" ${home}/.m2`,
    `p=$(ls -d ${JDK_COPIES}* | paste -sd, -)`,
    `touch "$g/gradle.properties"`,
    `sed -i '/^org\\.gradle\\.java\\.installations\\.paths=/d' "$g/gradle.properties"`,
    `echo "org.gradle.java.installations.paths=$p" >> "$g/gradle.properties"`,
    `{ echo '<toolchains>'; for d in ${JDK_COPIES}* "$JAVA_HOME"; do [ -x "$d/bin/java" ] || continue; v=$("$d/bin/java" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\\.specification\\.version = //p'); ${entry}; done; echo '</toolchains>'; } > ${home}/.m2/toolchains.xml`,
  ].join(" && ");
}

const isMaven = (tree: string, path: string) => exists(join(tree, path, "pom.xml"));
const mavenReactor = (tree: string, path: string) => /<modules>\s*<module>/.test(readText(join(tree, path, "pom.xml")).replace(/<!--[\s\S]*?-->/g, ""));

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

// Surefire's default includes (Test*, *Test, *Tests, *TestCase), each with a method no test has.
export const MAVEN_TEST_CLASSES = ["Test*", "*Test", "*Tests", "*TestCase"];
const MAVEN_NO_TEST = `'-Dtest=${MAVEN_TEST_CLASSES.map((c) => `${c}#readinessNoTest`).join(",")}'`;

function jvmCommands(tree: string, path: string): DraftCommand[] {
  const out: DraftCommand[] = [];
  if (isMaven(tree, path)) {
    const mvn = mvnOf(tree, path);
    const source = "pom.xml";
    const lint = lintTasks(tree, path, true);
    if (lint.length) out.push({ kind: "lint", command: `${mvn} -B -ntp ${lint.join(" ")}`, source, reason: `the lint plugins pom.xml declares (${lint.join(", ")})` });
    // Surefire resolves its test provider only when it runs, which dependency:go-offline misses, and
    // skipping tests would skip that too. A filter on Surefire's default test class names with no
    // matching method loads the provider while the network is on and runs no test. `*` would also
    // pick up a JPMS test module's module-info.class, which Surefire can't load (gson's test-jpms).
    out.push({ kind: "build", command: `${mvn} -B -ntp package ${MAVEN_NO_TEST} -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false`, source, reason: "Maven's package phase, with Surefire's test provider loaded and no test run" });
    // In a reactor, a module's tests can need a sibling's jar rather than its classes: gson's
    // test-jpms reads com.google.gson from the jar ModiTect adds module-info to at package. The
    // package phase runs every module's tests and hands the next module the jar; the build step has
    // already run it with the network on, so nothing more is downloaded.
    if (mavenReactor(tree, path)) out.push({ kind: "test", command: `${mvn} -B -ntp -o package`, source, reason: "Maven's tests through the package phase, offline, so a module whose tests need a sibling's jar gets it" });
    else out.push({ kind: "test", command: `${mvn} -B -ntp -o test`, source, reason: "Maven's test phase, offline" });
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

// Maven's "Failed to execute goal" block and Gradle's "What went wrong", as the build's cause.
const MAVEN_GENERIC = /^(Compilation failure|There are test failures\.?|There was an error in the forked process|)$/;
const MAVEN_BOILERPLATE = /^(-> \[Help \d+\]|To see the full stack trace|Re-run Maven using|For more information about the errors|\[Help \d+\]|After correcting the problems|mvn <args>|Please refer to )/;

export function mavenRoot(text: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\[ERROR\] Failed to execute goal /.test(l));
  if (at < 0) return null;
  const m = lines[at].match(/^\[ERROR\] Failed to execute goal (?:[\w.-]+:([\w.-]+):[\w.-]+:([\w-]+) \([^)]*\) )?on project ([\w.-]+):\s*(.*?)\s*(?:-> \[Help \d+\])?\s*$/);
  if (!m) return null;
  const [, artifact, goal, project, message] = m;
  const step = artifact && goal ? `${artifact.replace(/^maven-/, "").replace(/(-maven)?-plugin$/, "")}:${goal}` : "the build";
  const rest: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("[ERROR]")) break;
    const body = l.replace(/^\[ERROR\]\s?/, "").trim();
    if (/^(-> \[Help \d+\]|To see the full stack trace)/.test(body)) break;
    if (body && !MAVEN_BOILERPLATE.test(body)) rest.push(body);
  }
  const compile = rest.find((l) => /\S+\.(java|kt|groovy|scala):\[\d+,\d+\]/.test(l));
  const thrown = rest.find((l) => /^(?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Error|Exception)\b/.test(l));
  const said = message.endsWith(":") ? `${message} ${rest[0] ?? ""}`.trim() : MAVEN_GENERIC.test(message) ? (compile ?? thrown ?? rest[0] ?? message) : message;
  return clip(`${step} failed in module ${project}: ${said || "no message"}`, 240);
}

function gradleRoot(text: string): string | null {
  const block = text.match(/^\* What went wrong:\n([\s\S]*?)(?=\n\* (?:Try|Where|Exception is):|\n\n|(?![\s\S]))/m)?.[1];
  if (!block) return null;
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l && !/^Required by:|^(project|root project) [:']/.test(l));
  const head = lines[0]?.replace(/^>\s*/, "");
  if (!head) return null;
  const deepest = [...lines].reverse().find((l) => l.startsWith(">"))?.replace(/^>\s*/, "");
  const first = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
  const said = deepest && first(deepest) !== first(head) ? `${first(head).replace(/\.$/, "")}: ${first(deepest)}` : first(head);
  return clip(said, 240);
}

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
    runners: /(^|[\s/])(gradlew?|mvnw?)\s+(\S+\s+)*(test|check|verify|package)\b/,
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
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: /^(mvn|\.\/mvnw|mvnw|gradle|\.\/gradlew|gradlew|java|javac|kotlinc)$/,
    countedTests: isTest,
    ciTest: null,
  },
  mutation: {
    isTest,
    isSource,
    covered: (_tree, _comp, tests, files) => namedAfter(tests, files, isSource),
    sites: (line) => cLikeSites(line, true),
    quoted: (text) => cLikeQuoted(text, false),
    compileProbe: (comp) => ({ command: compileProbe(comp.packageManager), cwd: comp.path }),
    compileError: (output) => /COMPILATION ERROR|Compilation failure|Compilation failed|\.java:\d+: error:|^e: (file:\/\/)?\/|Compilation error\. See log/m.test(output),
  },
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
    toolchains: (tree, dir) =>
      extraJdks(tree, dir).map((j) => ({ spec: `JDK ${j.version}`, image: temurin(j.version), from: "/opt/java/openjdk", to: `${JDK_COPIES}${j.version}`, reason: j.reason, register: registerJdks })),
    testCounts: jvmTestCounts,
    budget: { commandTimeoutSec: 1200, componentMinutes: 45, mutationRunTimeoutSec: 900 },
  },
  output: { rootErrors: [mavenRoot, gradleRoot] },
};
