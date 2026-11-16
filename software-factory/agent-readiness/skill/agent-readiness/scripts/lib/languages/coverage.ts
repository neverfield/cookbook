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
// covers cart.rb, and jwt_spec.rb covers what is in a jwt/ folder of sources. A test whose name
// names no source, such as IntegrationTests.cs, covers the sources in its mirrored folder
// (mirroredFolder), or under it when that folder holds none directly.
export function namedAfter(tests: string[], files: string[], isSource: (f: string) => boolean, affixes: RegExp[] = TEST_AFFIXES): string[] {
  const sources = files.filter(isSource);
  const out = new Set<string>();
  for (const t of tests) {
    const s = stem(t);
    const bare = affixes.map((a) => s.replace(a, "")).filter((b) => b && b !== s).map((b) => b.toLowerCase());
    const named = sources.filter((f) => bare.includes(stem(f).toLowerCase()) || dirname(f).split("/").some((d) => bare.includes(d.toLowerCase())));
    if (named.length) {
      for (const f of named) out.add(f);
      continue;
    }
    const key = mirroredFolder(t);
    const same = sources.filter((f) => mirroredFolder(f) === key);
    const under = same.length || !key ? same : sources.filter((f) => mirroredFolder(f).startsWith(`${key}/`));
    for (const f of under) out.add(f);
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
