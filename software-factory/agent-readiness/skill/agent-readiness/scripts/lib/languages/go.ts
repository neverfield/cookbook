import { join } from "node:path";
import { exists, readText } from "../util.ts";
import type { Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Go and Rust group. Recognized and listed with its share of changes; not scored until
// this file has `replay` hooks and the stack moves to the supported tier.

function requires(tree: string, path: string): boolean {
  const mod = join(tree, path, "go.mod");
  return exists(mod) && /^require\b/m.test(readText(mod));
}

const vendored = (tree: string, path: string) => exists(join(tree, path, "vendor", "modules.txt"));

const goModules: Ecosystem = {
  id: "go",
  label: "Go modules",
  lockfiles: ["go.mod", "go.sum"],
  rule: "`go mod download` with `-mod=readonly`, from a committed `go.sum` that covers every module `go.mod` requires; a committed `vendor/modules.txt` counts as the lock",
  install: (tree, path) => {
    if (vendored(tree, path)) return { command: "go mod verify && go list -mod=vendor ./... >/dev/null", reason: "vendored modules in vendor/, checked against go.sum", frozen: true };
    if (!requires(tree, path)) return { command: "GOFLAGS=-mod=readonly go mod download", reason: "go.mod requires no modules", frozen: true };
    return exists(join(tree, path, "go.sum"))
      ? { command: "GOFLAGS=-mod=readonly go mod download", reason: "download of the modules go.sum pins, without changing go.mod", frozen: true }
      : { command: "go mod download", reason: "no go.sum, so the install can't be frozen", frozen: false };
  },
  unpinned: (tree, path) => (requires(tree, path) && !exists(join(tree, path, "go.sum")) && !vendored(tree, path) ? "go.mod requires modules but no go.sum is committed" : null),
};

export const go: LanguageDef = {
  id: "go",
  label: "Go",
  codes: ["go"],
  stacks: [{ id: "go", label: "Go", kind: "stack", tier: "not_assessed", files: /\.go$|(^|\/)go\.(mod|sum)$/, proof: ["fixtures/unsupported-go-service", "google/uuid@2d3c2a9"] }],
  detect: {
    manifests: [{ match: /^go\.mod$/, stack: "go", rank: 20 }],
    sources: [{ ext: /\.go$/, stack: "go", rank: 20 }],
    rootApp: { names: ["go.mod"], stack: "go", toolchain: "Go", suffix: "go", rank: 30 },
    lockfiles: ["go.sum"],
    projectName: (_tree, manifest, text) => (manifest === "go.mod" ? text.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop() : undefined),
  },
  ecosystems: [goModules],
};
