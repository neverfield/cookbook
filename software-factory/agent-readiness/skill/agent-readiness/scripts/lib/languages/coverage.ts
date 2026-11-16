import { basename, dirname, join } from "node:path";
import { readText } from "../util.ts";

// Ways to find the source a test covers when tests don't import files by relative path, as Go,
// Rust, Java, Kotlin, C#, PHP and Ruby tests don't. A language's `mutation.covered` combines them.
// Every path is relative to the tree, and every result is sorted, so the same code gives the same
// faults on every machine.

const stem = (f: string) => basename(f).replace(/\.[^.]+$/, "");

// Sources in the folder of any test: a Go test sits in the package it tests.
export function sameFolder(tests: string[], files: string[], isSource: (f: string) => boolean): string[] {
  const dirs = new Set(tests.map((t) => dirname(t)));
  return files.filter((f) => isSource(f) && dirs.has(dirname(f))).sort();
}

// The affixes test files add to the name of what they test: FooTest, FooTests, FooSpec, FooIT,
// foo_test, foo_spec, test_foo.
export const TEST_AFFIXES: RegExp[] = [/Tests?$/, /Spec$/, /IT$/, /_test$/, /_spec$/, /^test_/];

// The folder a test or source file sits in, with the layout's test and source roots taken out, so a
// test and the code it tests give the same key: src/test/java/a/b and src/main/java/a/b give a/b,
// tests/Unit/Http and src/Http give Http, tests/Shop.Tests/Orders and src/Shop/Orders give
// Shop/Orders, spec/models and app/models give models.
const ROOT_SEGMENTS = new Set(["src", "lib", "app", "test", "tests", "spec", "specs", "unit", "integration", "functional", "feature", "features"]);

export function mirroredFolder(path: string): string {
  const dir = dirname(path) === "." ? "" : dirname(path);
  const parts = dir.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // Maven and Gradle source sets: src/<set>/<language>/...
    if (parts[i] === "src" && /^(main|test|it|integrationTest|testFixtures)$/.test(parts[i + 1] ?? "") && /^(java|kotlin|scala|groovy)$/.test(parts[i + 2] ?? "")) {
      i += 2;
      continue;
    }
    if (ROOT_SEGMENTS.has(parts[i].toLowerCase())) continue;
    const project = parts[i].replace(/\.(Unit|Integration|Functional|Acceptance)?Tests?$/, "");
    if (project) out.push(project);
  }
  return out.join("/");
}

// Sources named after a test, wherever they are: OrderTest.java covers Order.java, cart_spec.rb
// covers cart.rb. When no test names a source, as when tests are named by feature
// (IntegrationTests.cs, jwt_spec.rb for lib/jwt/encode.rb), each test covers instead the sources in
// a folder its name names, else those in its mirrored folder (mirroredFolder), else those under
// it. The fallback applies only then, so a component whose tests name their sources keeps exactly
// those targets.
export function namedAfter(tests: string[], files: string[], isSource: (f: string) => boolean, affixes: RegExp[] = TEST_AFFIXES): string[] {
  const sources = files.filter(isSource);
  const bareNames = (t: string) => {
    const s = stem(t);
    return affixes.map((a) => s.replace(a, "")).filter((b) => b && b !== s).map((b) => b.toLowerCase());
  };
  const named = sources.filter((f) => tests.some((t) => bareNames(t).includes(stem(f).toLowerCase())));
  if (named.length || tests.length === 0) return named.sort();
  const out = new Set<string>();
  for (const t of tests) {
    const bare = bareNames(t);
    const inFolder = sources.filter((f) => dirname(f).split("/").some((d) => bare.includes(d.toLowerCase())));
    const key = mirroredFolder(t);
    const same = sources.filter((f) => mirroredFolder(f) === key);
    const under = same.length || !key ? same : sources.filter((f) => mirroredFolder(f).startsWith(`${key}/`));
    for (const f of inFolder.length ? inFolder : under) out.add(f);
  }
  return [...out].sort();
}

// Sources that hold their own tests, such as a Rust file with a #[cfg(test)] module.
export function withInlineTests(tree: string, files: string[], isSource: (f: string) => boolean, marker: RegExp): string[] {
  return files.filter((f) => isSource(f) && marker.test(readText(join(tree, f)))).sort();
}

// The files under a component's folder, for the helpers above.
export function inComponent(files: string[], path: string): string[] {
  return path === "." ? files : files.filter((f) => f.startsWith(`${path}/`));
}
