import { join } from "node:path";
import { exists, readJson } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the PHP and Ruby group. Recognized and listed with its share of changes; not scored until
// this file has `replay` hooks and the stack moves to the supported tier.

// Packages beyond PHP itself and its extensions, which composer.lock pins.
function requiresPackages(tree: string, path: string): boolean {
  const f = join(tree, path, "composer.json");
  if (!exists(f)) return false;
  try {
    const c = readJson<{ require?: Record<string, string>; "require-dev"?: Record<string, string> }>(f);
    return Object.keys({ ...c.require, ...c["require-dev"] }).some((k) => k !== "php" && !k.startsWith("ext-") && !k.startsWith("lib-"));
  } catch {
    return true;
  }
}

const composer: Ecosystem = {
  id: "composer",
  label: "Composer",
  lockfiles: ["composer.lock"],
  rule: "`composer install` from a committed `composer.lock`",
  install: (tree, path, { ignoreScripts }) => {
    const flags = `--no-interaction --no-progress${ignoreScripts ? " --no-scripts" : ""}`;
    return exists(join(tree, path, "composer.lock"))
      ? { command: `composer install ${flags}`, reason: "install from composer.lock", frozen: true }
      : { command: `composer install ${flags}`, reason: "no composer.lock, so the install can't be frozen", frozen: false };
  },
  unpinned: (tree, path) => (requiresPackages(tree, path) && !exists(join(tree, path, "composer.lock")) ? "no composer.lock is committed" : null),
};

export const php: LanguageDef = {
  id: "php",
  label: "PHP",
  codes: ["php"],
  stacks: [{ id: "php", label: "PHP", kind: "stack", tier: "not_assessed", files: /\.php$|(^|\/)composer\.(json|lock)$/, proof: ["laravel/laravel@def7ce1"] }],
  detect: {
    manifests: [{ match: /^composer\.json$/, stack: "php", rank: 60 }],
    sources: [{ ext: /\.php$/, stack: "php", rank: 70 }],
    rootApp: { names: ["composer.json"], stack: "php", toolchain: "PHP", suffix: "php", rank: 10 },
    lockfiles: ["composer.lock"],
    projectName: (_tree, manifest, text) => (manifest === "composer.json" ? text.match(/"name"\s*:\s*"(?:[^"/]+\/)?([^"]+)"/)?.[1] : undefined),
  },
  ecosystems: [composer],
};
