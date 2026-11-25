import { languageOf } from "../languages/index.ts";
import { isTestFile } from "../mutate.ts";
import type { Component, Profile } from "../types.ts";

const JS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

// Whether a file is a test by the component's language rule: its language file's, or the Node and
// Python rule faults are planted by.
function testRule(c: Component): (f: string) => boolean {
  const own = languageOf(c.language)?.replay?.mutation?.isTest;
  if (own) return own;
  if (c.language === "py") return (f) => f.endsWith(".py") && isTestFile(f);
  if (c.language === "ts" || c.language === "js") return (f) => JS.test(f) && isTestFile(f) && !f.includes("node_modules/");
  return () => false;
}

const under = (path: string, f: string) => path === "." || f.startsWith(`${path}/`);

// The test files a component holds: under its folder, by its language's rule, and in no other
// component or satellite nested inside it. A component with none and no test command has no tests.
export function ownTestFiles(files: string[], profile: Pick<Profile, "components" | "satellites">, c: Component): number {
  const nested = [...profile.components.map((x) => x.path), ...profile.satellites.map((s) => s.path)].filter((p) => p !== c.path && p !== "." && under(c.path, `${p}/`));
  const isTest = testRule(c);
  return files.filter((f) => under(c.path, f) && !nested.some((p) => under(p, f)) && isTest(f)).length;
}
