import { join } from "node:path";
import { exists } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Go and Rust group. Recognized and listed with its share of changes; not scored until
// this file has `replay` hooks and the stack moves to the supported tier.

const cargo: Ecosystem = {
  id: "cargo",
  label: "Cargo",
  lockfiles: ["Cargo.lock"],
  rule: "`cargo fetch --locked` from a committed `Cargo.lock`; a workspace's members share the root's",
  install: (tree, path) =>
    exists(join(tree, path, "Cargo.lock"))
      ? { command: "cargo fetch --locked", reason: "frozen fetch from Cargo.lock", frozen: true }
      : { command: "cargo fetch", reason: "no Cargo.lock, so the install can't be frozen", frozen: false },
  unpinned: (tree, path) => (exists(join(tree, path, "Cargo.lock")) ? null : "no Cargo.lock is committed"),
};

export const rust: LanguageDef = {
  id: "rust",
  label: "Rust",
  codes: ["rust"],
  stacks: [{ id: "rust", label: "Rust", kind: "stack", tier: "not_assessed", files: /\.rs$|(^|\/)Cargo\.(toml|lock)$/, proof: ["BurntSushi/ripgrep@91f5d22"] }],
  detect: {
    manifests: [{ match: /^Cargo\.toml$/, stack: "rust", rank: 30 }],
    sources: [{ ext: /\.rs$/, stack: "rust", rank: 30 }],
    rootApp: { names: ["Cargo.toml"], stack: "rust", toolchain: "Rust", suffix: "rust", rank: 40 },
    lockfiles: ["Cargo.lock"],
    projectName: (_tree, manifest, text) => (manifest === "Cargo.toml" ? text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] : undefined),
  },
  ecosystems: [cargo],
};
