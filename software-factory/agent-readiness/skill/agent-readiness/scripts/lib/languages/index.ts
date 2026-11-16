import type { Language, PackageManager } from "../types.ts";
import { dotnet } from "./dotnet.ts";
import { go } from "./go.ts";
import { jvm } from "./jvm.ts";
import type { Detect, Ecosystem, LanguageDef } from "./language.ts";
import { node } from "./node.ts";
import { cpp, dart, elixir, swift, terraform } from "./others.ts";
import { php } from "./php.ts";
import { python } from "./python.ts";
import { ruby } from "./ruby.ts";
import { rust } from "./rust.ts";

// The registry: every language file, listed once. Detection order comes from each rule's rank, not
// from this list, so a new file never has to move another.
export const LANGUAGES: LanguageDef[] = [node, python, go, rust, jvm, dotnet, php, ruby, swift, dart, elixir, terraform, cpp];

export const ECOSYSTEMS: Ecosystem[] = LANGUAGES.flatMap((l) => l.ecosystems);

export function languageOf(code: Language | undefined): LanguageDef | undefined {
  return code ? LANGUAGES.find((l) => l.codes.includes(code)) : undefined;
}

export function languageOfStack(stack: string | undefined): LanguageDef | undefined {
  return stack ? LANGUAGES.find((l) => l.stacks.some((s) => s.id === stack)) : undefined;
}

export function ecosystemOf(pm: PackageManager | null | undefined): Ecosystem | undefined {
  return pm ? ECOSYSTEMS.find((e) => e.id === pm) : undefined;
}

type Ranked<K extends keyof Detect> = NonNullable<Detect[K]> extends (infer T)[] ? T : never;

const byRank = <T extends { rank: number }>(xs: T[]) => [...xs].sort((a, b) => a.rank - b.rank);

export function manifestRules(): (Ranked<"manifests"> & { language: LanguageDef })[] {
  return byRank(LANGUAGES.flatMap((l) => (l.detect.manifests ?? []).map((m) => ({ ...m, language: l }))));
}

export function sourceRules(): (Ranked<"sources"> & { language: LanguageDef })[] {
  return byRank(LANGUAGES.flatMap((l) => (l.detect.sources ?? []).map((s) => ({ ...s, language: l }))));
}

export function rootAppRules(): (NonNullable<Detect["rootApp"]> & { language: LanguageDef })[] {
  return byRank(LANGUAGES.flatMap((l) => (l.detect.rootApp ? [{ ...l.detect.rootApp, language: l }] : [])));
}

export function lockfileNames(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.detect.lockfiles ?? []))];
}

// Every pinned image a language file contributes, tag to digest.
export function languageImages(): Record<string, string> {
  return Object.assign({}, ...LANGUAGES.map((l) => l.replay?.images ?? {}));
}

// Display names for component languages, for the report.
export const LANGUAGE_LABELS: Partial<Record<Language, string>> = { ts: "TypeScript", js: "Node", py: "Python", go: "Go", rust: "Rust", java: "Java", kotlin: "Kotlin", csharp: "C#", php: "PHP", ruby: "Ruby" };
