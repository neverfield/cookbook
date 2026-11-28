import { languageOf } from "../languages/index.ts";
import type { Component, Profile } from "../types.ts";

// Whether a file is a test by the component's language rule; none for a language without one.
function testRule(c: Component): (f: string) => boolean {
  return languageOf(c.language)?.checks.countedTests ?? (() => false);
}

const under = (path: string, f: string) => path === "." || f.startsWith(`${path}/`);

// The test files a component holds: under its folder, by its language's rule, and in no other
// component or satellite nested inside it. A component with none and no test command has no tests.
export function ownTestFiles(files: string[], profile: Pick<Profile, "components" | "satellites">, c: Component): number {
  const nested = [...profile.components.map((x) => x.path), ...profile.satellites.map((s) => s.path)].filter((p) => p !== c.path && p !== "." && under(c.path, `${p}/`));
  const isTest = testRule(c);
  return files.filter((f) => under(c.path, f) && !nested.some((p) => under(p, f)) && isTest(f)).length;
}
