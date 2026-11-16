import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { commandTimeout, discoverContract, imagePlan } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { JDKS, MAVEN_TEST_CLASSES, cLikeQuoted, cLikeSites, enforcedJava, jdkFor, jvm, jvmTestCounts } from "../skill/agent-readiness/scripts/lib/languages/jvm.ts";
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

  // The Mac's rerun of square/moshi@889013e at dfe50b0 failed the build with "Cannot find a Java
  // installation ... matching: {languageVersion=21 ...}" in eclipse-temurin:17-jdk: the root build's
  // toolchain reads `jdk = "21"` from the version catalog, and only records-tests' literal 17 was seen.
  test("a Gradle toolchain from the version catalog picks the JDK (square/moshi@889013e)", () => {
    const moshi = repo({
      "build.gradle.kts": 'subprojects {\n  pluginManager.withPlugin("java") {\n    configure<JavaPluginExtension> {\n      toolchain { languageVersion.set(libs.versions.jdk.map(JavaLanguageVersion::of)) }\n    }\n    tasks.withType<JavaCompile>().configureEach { options.release.set(8) }\n  }\n}\n',
      "gradle/libs.versions.toml": '[versions]\njdk = "21"\njvmTarget = "1.8"\nkotlin = "2.3.0"\n\n[libraries]\nokio = { module = "com.squareup.okio:okio", version = "3.16.4" }\n',
      "moshi/records-tests/build.gradle.kts": "plugins { `java-library` }\n\njava { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }\n",
      "moshi/build.gradle.kts": "tasks.named<JavaCompile>(\"compileJava16Java\") { options.release = 16 }\n",
      gradlew: "",
      "gradle/wrapper/gradle-wrapper.properties": WRAPPER("9.5.1"),
    });
    assert.equal(jdkFor(moshi, "."), 21);
    assert.equal(hooks.image(moshi, "."), "eclipse-temurin:21-jdk");
    const kts = (build: string, toml = '[versions]\njava-toolchain = "17"\n') => jdkFor(repo({ "build.gradle.kts": build, "gradle/libs.versions.toml": toml }), ".");
    assert.equal(kts("kotlin { jvmToolchain(libs.versions.java.toolchain.get().toInt()) }\n"), 17, "kebab keys are dotted accessors");
    assert.equal(kts("java { toolchain { languageVersion = JavaLanguageVersion.of(libs.versions.jdk.get()) } }\n", '[versions]\njdk = { strictly = "11" }\n'), 11);
    assert.equal(kts('java { toolchain { languageVersion = JavaLanguageVersion.of("17") } }\n'), 17, "a quoted literal");
    assert.equal(kts("java { toolchain { languageVersion = JavaLanguageVersion.of(libs.versions.missing.get()) } }\n"), 21, "a key the catalog lacks: the default");
    assert.equal(kts('val okio = libs.versions.okio.get()\n', '[versions]\nokio = "3"\n'), 21, "a catalog version outside a toolchain isn't a JDK");
  });

  test("a Maven Enforcer requireJavaVersion range bounds the JDK: google/gson@6c06cbc compiles for 8 and tests on 11 and 17, and enforces [17,26)", () => {
    const gson = repo({
      "pom.xml": `<project><artifactId>gson-parent</artifactId><properties><maven.compiler.release>8</maven.compiler.release><maven.compiler.testRelease>11</maven.compiler.testRelease></properties>
        <build><plugins><plugin><artifactId>maven-enforcer-plugin</artifactId><executions><execution><configuration><rules>
        <requireMavenVersion><version>[3.3.1,)</version></requireMavenVersion>
        <requireJavaVersion><version>[17,26)</version></requireJavaVersion></rules></configuration></execution></executions></plugin></plugins></build></project>`,
      "gson/pom.xml": "<project><artifactId>gson</artifactId><properties><maven.compiler.testRelease>17</maven.compiler.testRelease></properties></project>",
    });
    assert.deepEqual(enforcedJava(gson, "."), { min: 17, max: 25 }, "requireMavenVersion's range isn't the Java rule");
    assert.equal(jdkFor(gson, "."), 17);
    assert.equal(hooks.image(gson, "."), "maven:3.9-eclipse-temurin-17", "the review's run got temurin-11, which the enforcer refuses");
    const withEnforcer = (range: string, props = "") => repo({ "pom.xml": `<project><properties>${props}</properties><build><plugins><plugin><artifactId>maven-enforcer-plugin</artifactId><configuration><rules><requireJavaVersion><version>${range}</version></requireJavaVersion></rules></configuration></plugin></plugins></build></project>` });
    assert.equal(jdkFor(withEnforcer("11"), "."), 21, "a bare version is a minimum, so the default still applies");
    assert.equal(jdkFor(withEnforcer("[1.8,12)"), "."), 11, "the default 21 is above the range, so the highest LTS inside it");
    assert.equal(jdkFor(withEnforcer("(11,)", "<maven.compiler.release>8</maven.compiler.release>"), "."), 17, "an exclusive lower bound");
    assert.equal(jdkFor(withEnforcer("[21,)", "<maven.compiler.release>17</maven.compiler.release>"), "."), 21);
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
    assert.match(plan.command, /try \{ def a = c\.incoming\.artifactView \{ lenient\(true\) \}\.artifacts; a\.artifactFiles\.files; a\.failures\.findAll \{[^]*\} catch \(e\) \{ \} \} \}; if \(bad\)/, "a configuration that throws, while resolving or listing its failures, is skipped");
    assert.match(plan.command, /if \(bad\) throw bad\[0\]/, "a dependency that can't be resolved fails the install, unlike gradle dependencies");
    assert.match(plan.command, /g\.parent == null \|\| why =~ \/Could not \(GET\|HEAD\) \//, "in an included build, resolved before the composite's substitutions, only a failed registry request fails (mockito-kotlin's tests build)");
    assert.doesNotMatch(RESOLVE_QUOTES(plan.command), /'/, "the script has no single quote, so the shell's printf keeps it whole");
    assert.match(plan.command, /&& JAVA_TOOL_OPTIONS="-Duser\.home=\$HOME" \.\/gradlew --no-daemon -I "\$HOME\/readiness-resolve\.gradle" help$/, "no -q, so Gradle's Could not GET line reaches the diagnosis");
    assert.equal(plan.frozen, true);
  });

  // The Mac's open-network run of square/moshi@889013e failed the injected install on Dokka's
  // configurations ("No matching variant ... org.jetbrains.dokka"). Gradle wraps that error: the
  // failure's own message is "Could not resolve ...", and the variant error is its cause.
  test("a configuration no variant matches is skipped wherever the cause chain says so, and so is one deprecated for resolution (square/moshi@889013e)", () => {
    const script = RESOLVE_QUOTES(ecosystemOf("gradle")!.install(repo({ "build.gradle.kts": "", gradlew: "" }), ".", { ignoreScripts: false }).command);
    assert.match(script, /def why = chain\(f\); !\(why =~ \/Cannot choose between\|No matching variant\|No matching configuration\|No variants of\/\)/);
    assert.doesNotMatch(script, /f\.message =~/, "never the top message alone");
    assert.match(script, /matching \{ it\.canBeResolved && !\(it\.respondsTo\("isDeprecatedForResolution"\) && it\.isDeprecatedForResolution\(\)\) \}/);
    const variant = /Cannot choose between|No matching variant|No matching configuration|No variants of/;
    const dokka = [
      "Could not resolve org.jetbrains.dokka:dokka-base:2.0.0.",
      "No matching variant of org.jetbrains.dokka:dokka-base:2.0.0 was found. The consumer was configured to find a library for use during runtime, compatible with Java 17, packaged as a jar, preferably optimized for standard JVMs, and its dependencies declared externally, as well as attribute 'org.jetbrains.dokka.format' with value 'html' but:",
    ];
    assert.ok(!variant.test(dokka[0]) && variant.test(dokka.join(" ")), "only the chain names the variant error");
    const blocked = ["Could not resolve com.squareup.okio:okio:3.9.0.", "Could not get resource 'https://repo.maven.apache.org/maven2/com/squareup/okio/okio/3.9.0/okio-3.9.0.pom'.", "Could not GET 'https://repo.maven.apache.org/maven2/com/squareup/okio/okio/3.9.0/okio-3.9.0.pom'."];
    assert.ok(!variant.test(blocked.join(" ")), "a blocked registry still fails the install");
  });

  // The Mac's open-network run of google/gson@6c06cbc failed the build in test-jpms with
  // "NoClassDefFoundError: module-info is not a class because access_flag ACC_MODULE is set": `-Dtest=*`
  // replaced Surefire's includes, so it tried to load the module's test module-info.class.
  test("the Maven build loads Surefire's provider through its default test class names, never module-info (google/gson@6c06cbc)", () => {
    const gson = repo({
      "pom.xml": "<project><artifactId>gson-parent</artifactId><modules><module>gson</module><module>test-jpms</module></modules></project>",
      "gson/pom.xml": "<project><artifactId>gson</artifactId></project>",
      "gson/src/main/java/module-info.java": "module com.google.gson {}\n",
      "test-jpms/pom.xml": "<project><artifactId>test-jpms</artifactId></project>",
      "test-jpms/src/test/java/module-info.java": "module com.google.gson.jpms_test { requires com.google.gson; }\n",
      "test-jpms/src/test/java/com/google/gson/jpms_test/ExportedPackagesTest.java": "",
    });
    const build = hooks.commands(gson, { path: "." } as never).find((c) => c.kind === "build")!.command;
    assert.equal(build, `JAVA_TOOL_OPTIONS="-Duser.home=$HOME" mvn -B -ntp package '-Dtest=Test*#readinessNoTest,*Test#readinessNoTest,*Tests#readinessNoTest,*TestCase#readinessNoTest' -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false`);
    assert.doesNotMatch(build, /-DskipTests|maven\.test\.skip/, "skipping tests would skip the provider download the offline test run needs");
    const filter = build.match(/'-Dtest=([^']+)'/)![1];
    const classes = filter.split(",").map((p) => new RegExp(`^${p.replace(/#readinessNoTest$/, "").replace(/\*/g, "[^/]*")}$`));
    assert.deepEqual(classes.map(String), MAVEN_TEST_CLASSES.map((c) => `/^${c.replace(/\*/g, "[^/]*")}$/`));
    const matched = (name: string) => classes.some((re) => re.test(name));
    for (const name of ["module-info", "package-info", "Helpers"]) assert.ok(!matched(name), name);
    for (const name of ["ExportedPackagesTest", "TestGson", "ReflectionTests", "JsonTestCase"]) assert.ok(matched(name), name);
  });

  // The Mac's rerun of google/gson@6c06cbc at dfe50b0: the build passed, then `mvn -o test` failed at
  // test-jpms testCompile with "module-info.java:[19,22] module not found: com.google.gson". The test
  // phase hands test-jpms gson's classes, and ModiTect adds module-info only to the packaged jar.
  test("a Maven reactor's offline tests run through package, so a module gets its sibling's jar; a single module keeps the test phase (google/gson@6c06cbc)", () => {
    const test = (files: Record<string, string>) => hooks.commands(repo(files), { path: "." } as never).find((c) => c.kind === "test")!.command;
    const gson = test({ "pom.xml": "<project><artifactId>gson-parent</artifactId>\n  <modules>\n    <module>gson</module>\n    <module>test-jpms</module>\n  </modules>\n</project>" });
    assert.equal(gson, 'JAVA_TOOL_OPTIONS="-Duser.home=$HOME" mvn -B -ntp -o package');
    assert.equal(test({ "pom.xml": pom() }), 'JAVA_TOOL_OPTIONS="-Duser.home=$HOME" mvn -B -ntp -o test', "jsoup and spring-petclinic are single modules");
    assert.equal(test({ "pom.xml": "<project><!-- <modules><module>old</module></modules> --></project>" }), 'JAVA_TOOL_OPTIONS="-Duser.home=$HOME" mvn -B -ntp -o test', "a commented-out module list");
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
