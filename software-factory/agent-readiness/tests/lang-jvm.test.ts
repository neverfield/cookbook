import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { commandTimeout, discoverContract, imagePlan } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { JDKS, cLikeQuoted, cLikeSites, jdkFor, jvm, jvmTestCounts } from "../skill/agent-readiness/scripts/lib/languages/jvm.ts";
import { targetFiles, testFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { FIXTURES } from "../support/tools/fixture.ts";

const rubric = loadRubric(latestRubricVersion());
const hooks = jvm.replay!;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jvm-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const pom = (props = "") => `<project><artifactId>orders</artifactId><properties>${props}</properties></project>`;
const WRAPPER = (v: string) => `distributionUrl=https\\://services.gradle.org/distributions/gradle-${v}-bin.zip\n`;

describe("JVM: which JDK and image a component runs in", () => {
  test("the pinned Java version, or the next LTS above it, with 21 when nothing pins one", () => {
    assert.deepEqual(JDKS, [8, 11, 17, 21, 25]);
    assert.equal(jdkFor(repo({ "pom.xml": pom() }), "."), 21);
    assert.equal(jdkFor(repo({ "pom.xml": pom("<maven.compiler.release>17</maven.compiler.release>") }), "."), 17);
    assert.equal(jdkFor(repo({ "pom.xml": pom("<java.version>1.8</java.version>") }), "."), 8);
    assert.equal(jdkFor(repo({ "pom.xml": pom("<maven.compiler.release>22</maven.compiler.release>") }), "."), 25);
    assert.equal(jdkFor(repo({ "pom.xml": pom("<java.version>11</java.version>"), ".java-version": "17.0.9\n" }), "."), 17, ".java-version comes first");
    assert.equal(jdkFor(repo({ "pom.xml": pom(), ".sdkmanrc": "java=21.0.2-tem\n" }), "."), 21);
    assert.equal(jdkFor(repo({ "pom.xml": pom(), ".tool-versions": "nodejs 22\njava temurin-11.0.21+9\n" }), "."), 11);
  });

  test("a Gradle toolchain beats a release level, and the wrapper's Gradle must be able to run on the JDK", () => {
    const kts = "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\ntasks.withType<JavaCompile> { options.release = 21 }\n";
    assert.equal(jdkFor(repo({ "build.gradle.kts": kts }), "."), 17);
    assert.equal(jdkFor(repo({ "build.gradle.kts": "kotlin { jvmToolchain(21) }\n" }), "."), 21);
    assert.equal(jdkFor(repo({ "build.gradle": "sourceCompatibility = JavaVersion.VERSION_1_8\n" }), "."), 8);
    assert.equal(jdkFor(repo({ "build.gradle": "", gradlew: "", "gradle/wrapper/gradle-wrapper.properties": WRAPPER("7.6") }), "."), 17, "Gradle 7.6 can't run on 21");
    assert.equal(jdkFor(repo({ "build.gradle": "kotlin { jvmToolchain(11) }\n", gradlew: "", "gradle/wrapper/gradle-wrapper.properties": WRAPPER("9.4.1") }), "."), 17, "Gradle 9 needs Java 17 to run");
  });

  test("a wrapper runs on the plain JDK image; without one the build tool's own image supplies it", () => {
    assert.equal(hooks.image(repo({ "pom.xml": pom("<maven.compiler.release>17</maven.compiler.release>"), mvnw: "" }), "."), "eclipse-temurin:17-jdk");
    assert.equal(hooks.image(repo({ "pom.xml": pom() }), "."), "maven:3.9-eclipse-temurin-21");
    assert.equal(hooks.image(repo({ "build.gradle.kts": "", gradlew: "" }), "."), "eclipse-temurin:21-jdk");
    assert.equal(hooks.image(repo({ "build.gradle.kts": "" }), "."), "gradle:9-jdk21");
    assert.equal(hooks.image(repo({ "build.gradle": "sourceCompatibility = '11'\n" }), "."), "gradle:8-jdk11");
    for (const tag of [...JDKS.map((j) => `eclipse-temurin:${j}-jdk`), ...JDKS.map((j) => `maven:3.9-eclipse-temurin-${j}`), "gradle:8-jdk8", "gradle:8-jdk11", "gradle:9-jdk17", "gradle:9-jdk21", "gradle:9-jdk25"]) {
      assert.match(hooks.images[tag] ?? "", /^sha256:[0-9a-f]{64}$/, `${tag} is pinned`);
    }
  });
});

describe("JVM: detection, classification and pins", () => {
  test("Kotlin when Kotlin sources outnumber Java ones; Maven for a pom.xml, Gradle for a build script", () => {
    const dir = repo({ "build.gradle.kts": "", "src/main/kotlin/A.kt": "", "src/main/kotlin/B.kt": "", "src/main/java/C.java": "" });
    assert.deepEqual(hooks.classify(dir, ".", "build.gradle.kts"), { language: "kotlin", packageManager: "gradle" });
    assert.deepEqual(hooks.classify(repo({ "pom.xml": pom(), "src/main/java/A.java": "" }), ".", "pom.xml"), { language: "java", packageManager: "maven" });
  });

  test("an Android build is recognized and not scored, however it applies the plugin", () => {
    const refine = jvm.detect.refine!;
    assert.equal(refine("build.gradle.kts", "plugins {\n    alias(libs.plugins.android.application) apply false\n}\n"), "android");
    assert.equal(refine("build.gradle", "plugins { id 'com.android.library' }\n"), "android");
    assert.equal(refine("build.gradle", "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.7.3' } }\n"), "android");
    assert.equal(refine("app/build.gradle.kts", "android {\n  namespace = \"x\"\n}\n"), "android");
    assert.equal(refine("build.gradle.kts", 'plugins { kotlin("jvm") version "2.4.21" }\n'), undefined);
    assert.equal(refine("pom.xml", "<project/>"), undefined);
    const android = jvm.stacks.find((s) => s.id === "android")!;
    assert.equal(android.tier, "not_assessed");
    const dir = join(FIXTURES, "android-gradle", "repo");
    const notes = buildProfile(dir, dir, rubric).components.find((c) => c.id === "notes")!;
    assert.deepEqual([notes.stack, notes.assessed], ["android", false]);
    assert.match(notes.notAssessedReason ?? "", /^Android isn't supported yet: .*Android SDK/);
  });

  test("the toolchain condition needs the Java version and the build tool's wrapper", () => {
    const full = repo({ "pom.xml": pom("<maven.compiler.release>17</maven.compiler.release>"), mvnw: "", ".mvn/wrapper/maven-wrapper.properties": "" });
    assert.deepEqual(hooks.pins(full, "."), { found: ["pom.xml", ".mvn/wrapper/maven-wrapper.properties"], missing: [] });
    const bare = repo({ "build.gradle": "" });
    assert.deepEqual(hooks.pins(bare, ".").missing, [
      "the Java version (.java-version, or the release or toolchain the build sets)",
      "the Gradle version (a committed Gradle Wrapper, gradlew and gradle/wrapper/gradle-wrapper.properties)",
    ]);
  });

  test("a root Gradle project is named after rootProject.name", () => {
    const dir = join(FIXTURES, "kotlin-gradle", "repo");
    assert.deepEqual(buildProfile(dir, dir, rubric).components.map((c) => [c.id, c.language, c.packageManager, c.assessed]), [["loyalty", "kotlin", "gradle", true]]);
  });
});

// The init script printf writes, between the shell's single quotes.
const OPEN = "printf '%s\\n' '";
const RESOLVE_QUOTES = (command: string) => command.slice(command.indexOf(OPEN) + OPEN.length, command.indexOf("' > "));

describe("JVM: the contract", () => {
  test("every JVM command sets user.home to the audit's home, so ~/.m2 and ~/.gradle are the same on every machine", () => {
    const dir = join(FIXTURES, "java-maven", "repo");
    const profile = buildProfile(dir, dir, rubric);
    const contract = discoverContract(profile, dir, rubric, []);
    for (const c of contract.filter((x) => x.kind !== "doctor")) assert.ok(c.command.startsWith('JAVA_TOOL_OPTIONS="-Duser.home=$HOME" ./mvnw '), c.command);
    assert.deepEqual(contract.map((c) => c.kind), ["doctor", "install", "build", "test"]);
    assert.ok(contract.find((c) => c.kind === "test")!.command.includes(" -o test"), "tests run offline");
    assert.equal(commandTimeout(rubric, profile.components[0]), 1200, "the JVM's floor is above the rubric's limit");
    assert.deepEqual(imagePlan(profile, dir).slice(1), [{ image: "eclipse-temurin:17-jdk", components: ["orders"] }]);
  });

  test("the Gradle install downloads every configuration's files, since `gradle dependencies` downloads no jar", () => {
    const plan = ecosystemOf("gradle")!.install(repo({ "build.gradle.kts": "", gradlew: "" }), ".", { ignoreScripts: false });
    assert.match(plan.command, /a\.artifactFiles\.files \} catch \(e\) \{ return \}; a\.failures\.findAll/);
    assert.match(plan.command, /if \(bad\) throw bad\[0\]/, "a dependency that can't be resolved fails the install, unlike gradle dependencies");
    assert.match(plan.command, /g\.parent == null \|\| chain\(f\) =~ \/Could not \(GET\|HEAD\) \//, "in an included build, resolved before the composite's substitutions, only a failed registry request fails (mockito-kotlin's tests build)");
    assert.doesNotMatch(RESOLVE_QUOTES(plan.command), /'/, "the script has no single quote, so the shell's printf keeps it whole");
    assert.match(plan.command, /&& JAVA_TOOL_OPTIONS="-Duser\.home=\$HOME" \.\/gradlew --no-daemon -I "\$HOME\/readiness-resolve\.gradle" help$/, "no -q, so Gradle's Could not GET line reaches the diagnosis");
    assert.equal(plan.frozen, true);
  });

  test("lint runs only for a lint plugin the build declares; a multiplatform build runs its JVM tests", () => {
    const spotless = repo({ "build.gradle.kts": 'plugins { id("com.diffplug.spotless") version "7.0.0" }\n' });
    assert.deepEqual(hooks.commands(spotless, { path: "." } as never).map((c) => [c.kind, c.command.replace(/^JAVA_TOOL_OPTIONS="[^"]+" /, "")]), [
      ["lint", "gradle --no-daemon spotlessCheck"],
      ["build", "gradle --no-daemon assemble"],
      ["test", "gradle --no-daemon --offline test"],
    ]);
    const checkstyle = repo({ "pom.xml": "<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>" });
    assert.equal(hooks.commands(checkstyle, { path: "." } as never).some((c) => c.kind === "lint"), false, "Maven Checkstyle's rules sit in an execution the command line wouldn't use");
    const kmp = repo({ "build.gradle.kts": 'plugins { kotlin("multiplatform") }\n' });
    assert.match(hooks.commands(kmp, { path: "." } as never).find((c) => c.kind === "test")!.command, / --offline jvmTest$/);
  });

  test("test counts: Surefire's module totals, and Gradle's line when a test fails", () => {
    const surefire = [
      "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.027 s -- in com.example.orders.PricingTest",
      "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0",
      "[ERROR] Tests run: 6, Failures: 1, Errors: 1, Skipped: 1",
    ].join("\n");
    assert.deepEqual(jvmTestCounts(surefire), { passed: 7, failed: 2, total: 9 });
    assert.deepEqual(jvmTestCounts("PointsTest > tiers() FAILED\n3 tests completed, 1 failed\n"), { passed: 2, failed: 1, total: 3 });
    assert.equal(jvmTestCounts("BUILD SUCCESSFUL in 7s\n"), null);
  });

  test("a compile error from javac, Maven or kotlinc means the fault doesn't compile", () => {
    const err = hooks.mutation.compileError!;
    assert.ok(err("[ERROR] COMPILATION ERROR : \n[ERROR] /work/src/main/java/A.java:[14,12] cannot find symbol"));
    assert.ok(err("e: file:///work/src/main/kotlin/Points.kt:20:16 Unresolved reference 'bronze'."));
    assert.ok(err("A.java:3: error: ';' expected"));
    assert.ok(!err("PointsTest > tiers() FAILED"));
  });
});

describe("JVM and C#: fault sites and quoting", () => {
  test("faults go in main sources named after a test", () => {
    const dir = join(FIXTURES, "java-maven", "repo");
    const comp = buildProfile(dir, dir, rubric).components[0];
    assert.deepEqual(testFiles(dir, comp), ["src/test/java/com/example/orders/PricingTest.java"]);
    assert.deepEqual(targetFiles(dir, comp), ["src/main/java/com/example/orders/Pricing.java"]);
    assert.ok(hooks.mutation.isTest("src/jvmTest/kotlin/x/A.kt") && hooks.mutation.isTest("lib/src/main/java/x/OrderIT.java"));
    assert.ok(!hooks.mutation.isSource("build/generated/source/A.java") && !hooks.mutation.isSource("src/main/java/x/package-info.java"));
  });

  test("every fault is still valid code: no `void 0`, and Kotlin's dropped throw becomes Unit", () => {
    const ops = (line: string, semi = true) => cLikeSites(line, semi).map((s) => [s.operator, s.after.trim()]);
    assert.deepEqual(ops('      throw new IllegalArgumentException("weight must be positive");'), [["drop_throw_or_return", ";"]]);
    assert.deepEqual(ops('            throw IllegalArgumentException("not enough points")', false), [["drop_throw_or_return", "Unit"]]);
    assert.deepEqual(ops("    if (grams > 5000) {"), [
      ["boundary_flip", "if (grams >= 5000) {"],
      ["negate_condition", "if (!(grams > 5000)) {"],
      ["change_constant", "if (grams > 5001) {"],
    ]);
    assert.deepEqual(ops("      return true;"), [["swap_return", "return false;"]]);
    assert.deepEqual(ops('    log("a < b is 1");'), [], "nothing inside a string");
    assert.deepEqual(ops("@Size(max = 10)"), []);
    assert.deepEqual(ops("import java.util.List;"), []);
    assert.deepEqual(ops("    Thread.sleep(100);"), [], "timing constants are left alone");
  });

  test("block comments, text blocks and C# verbatim strings that span lines are text, not code", () => {
    const java = ["/**", " * if (x > 1) return true;", " */", "class A {", '  String s = """', "    if (a > 1)", '    """;', "  int f() { return 1; } // if (x)", "}"].join("\n");
    assert.deepEqual([...cLikeQuoted(java, false)].sort(), [0, 1, 2, 4, 5, 6]);
    const cs = ["var s = @\"line one", "if (x > 1) \"\"quoted\"\"", "end\";", "var t = \"if (a > 1)\";"].join("\n");
    assert.deepEqual([...cLikeQuoted(cs, true)].sort(), [0, 1, 2]);
    assert.deepEqual([...cLikeQuoted(cs, false)].sort(), [], "without verbatim strings, @\" is an ordinary string");
  });
});
