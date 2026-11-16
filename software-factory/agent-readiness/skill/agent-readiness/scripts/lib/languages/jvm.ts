import { basename, join } from "node:path";
import { exists, listFiles, readText } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Java, Kotlin and .NET group. Recognized and listed with its share of changes; not
// scored until this file has `replay` hooks and the stack moves to the supported tier.

const OUTPUT = /(^|\/)(target|build|out)\//;

function filesNamed(tree: string, path: string, name: RegExp): string[] {
  return listFiles(join(tree, path)).filter((f) => name.test(basename(f)) && !OUTPUT.test(f));
}

// A version that resolves differently over time: a range such as [1.0,2.0), or LATEST and RELEASE.
const MAVEN_DYNAMIC = /<version>\s*(\[[^<]*|\([^<]*|LATEST|RELEASE)\s*<\/version>/g;

function mavenDynamic(tree: string, path: string): number {
  return filesNamed(tree, path, /^pom\.xml$/).reduce((n, f) => n + [...readText(join(tree, path, f)).matchAll(MAVEN_DYNAMIC)].length, 0);
}

const maven: Ecosystem = {
  id: "maven",
  label: "Maven",
  lockfiles: [],
  rule: "`mvn dependency:go-offline` through the committed Maven Wrapper when there is one, with every dependency and plugin version fixed in `pom.xml`: no version ranges, `LATEST` or `RELEASE`",
  install: (tree, path) => {
    const mvn = exists(join(tree, path, "mvnw")) ? "./mvnw" : "mvn";
    const fixed = mavenDynamic(tree, path) === 0;
    return { command: `${mvn} -B -q dependency:go-offline`, reason: fixed ? "resolves the versions pom.xml fixes" : "pom.xml leaves some versions open, so the install can't be frozen", frozen: fixed };
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

const gradle: Ecosystem = {
  id: "gradle",
  label: "Gradle",
  lockfiles: ["gradle.lockfile"],
  rule: "`gradle dependencies` through the committed Gradle Wrapper, with dependency locking (`gradle.lockfile`) committed, or with no dynamic versions (`1.+`, `latest.release`, ranges) in the build",
  install: (tree, path) => {
    const gradlew = exists(join(tree, path, "gradlew")) ? "./gradlew" : "gradle";
    const fixed = gradleLocked(tree, path) || gradleDynamic(tree, path) === 0;
    return { command: `${gradlew} --no-daemon -q dependencies`, reason: fixed ? "resolves the versions the build fixes or locks" : "the build uses dynamic versions and commits no gradle.lockfile, so the install can't be frozen", frozen: fixed };
  },
  unpinned: (tree, path) => {
    if (gradleLocked(tree, path)) return null;
    const n = gradleDynamic(tree, path);
    return n ? `the Gradle build uses ${n} dynamic ${n === 1 ? "version" : "versions"} and commits no gradle.lockfile` : null;
  },
};

export const jvm: LanguageDef = {
  id: "jvm",
  label: "JVM",
  codes: ["java", "kotlin"],
  stacks: [{ id: "jvm", label: "JVM", kind: "stack", tier: "not_assessed", files: /\.(java|kt|kts|scala|gradle)$|(^|\/)pom\.xml$/, proof: ["spring-projects/spring-petclinic@500158f"] }],
  detect: {
    manifests: [{ match: /^(pom\.xml|build\.gradle(\.kts)?)$/, stack: "jvm", rank: 40 }],
    sources: [{ ext: /\.(java|kt|scala)$/, stack: "jvm", rank: 40 }],
    rootApp: { names: ["pom.xml", "build.gradle", "build.gradle.kts"], stack: "jvm", toolchain: "JVM", suffix: "jvm", rank: 50 },
    lockfiles: ["gradle.lockfile"],
    projectName: (_tree, manifest, text) => (manifest === "pom.xml" ? text.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] : undefined),
  },
  ecosystems: [maven, gradle],
};
