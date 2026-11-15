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

// Sources named after a test, wherever they are: OrderTest.java covers Order.java, cart_spec.rb
// covers cart.rb. A stem that names no source covers nothing.
export function namedAfter(tests: string[], files: string[], isSource: (f: string) => boolean, affixes: RegExp[] = TEST_AFFIXES): string[] {
  const wanted = new Set<string>();
  for (const t of tests) {
    const s = stem(t);
    for (const a of affixes) {
      const bare = s.replace(a, "");
      if (bare && bare !== s) wanted.add(bare.toLowerCase());
    }
  }
  return files.filter((f) => isSource(f) && wanted.has(stem(f).toLowerCase())).sort();
}

// Sources that hold their own tests, such as a Rust file with a #[cfg(test)] module.
export function withInlineTests(tree: string, files: string[], isSource: (f: string) => boolean, marker: RegExp): string[] {
  return files.filter((f) => isSource(f) && marker.test(readText(join(tree, f)))).sort();
}

// The files under a component's folder, for the helpers above.
export function inComponent(files: string[], path: string): string[] {
  return path === "." ? files : files.filter((f) => f.startsWith(`${path}/`));
}
