import { join } from "node:path";
import { exists } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the PHP and Ruby group. Recognized and listed with its share of changes; not scored until
// this file has `replay` hooks and the stack moves to the supported tier.

const bundler: Ecosystem = {
  id: "bundler",
  label: "Bundler",
  lockfiles: ["Gemfile.lock"],
  rule: "`bundle install` in frozen mode (`BUNDLE_FROZEN=true`) from a committed `Gemfile.lock`",
  install: (tree, path) =>
    exists(join(tree, path, "Gemfile.lock"))
      ? { command: "BUNDLE_FROZEN=true bundle install", reason: "frozen install from Gemfile.lock", frozen: true }
      : { command: "bundle install", reason: "no Gemfile.lock, so the install can't be frozen", frozen: false },
  unpinned: (tree, path) => (exists(join(tree, path, "Gemfile.lock")) ? null : "no Gemfile.lock is committed"),
};

export const ruby: LanguageDef = {
  id: "ruby",
  label: "Ruby",
  codes: ["ruby"],
  stacks: [{ id: "ruby", label: "Ruby", kind: "stack", tier: "not_assessed", files: /\.(rb|rake|erb|gemspec)$|(^|\/)(Gemfile|Rakefile)(\.lock)?$/, proof: ["spree/spree@cdd9a02"] }],
  detect: {
    manifests: [{ match: /^Gemfile$/, stack: "ruby", rank: 50 }],
    sources: [{ ext: /\.rb$/, stack: "ruby", rank: 60 }],
    rootApp: { names: ["Gemfile"], stack: "ruby", toolchain: "Ruby", suffix: "ruby", rank: 20 },
    lockfiles: ["Gemfile.lock"],
  },
  ecosystems: [bundler],
};
