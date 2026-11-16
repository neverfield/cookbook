// What the audit supports, one entry per stack the scan can recognise. references/supported.md
// lists the same entries in the same tiers; tests/supported.test.ts fails when the two drift.
// supported: the audit assesses it and gives a level. not_yet: the scan recognises it and gives no
// level, for a known reason. not_assessed: the scan lists it by name and share and has no support
// for it, so it gives no level.
import { LANGUAGES } from "./languages/index.ts";

export type SupportTier = "supported" | "not_yet" | "not_assessed";

export interface Stack {
  id: string;
  label: string;
  kind: "stack" | "machine";
  tier: SupportTier;
  // Why it isn't supported, said after "<label> isn't supported yet: ".
  reason?: string;
  // The files of a component in this stack, for a root app that shares "." with a root package.json.
  files?: RegExp;
  // Fixtures (fixtures/<name>) or pinned real repos (owner/repo@sha) that show the audit's behaviour.
  proof: string[];
}

export const SUPPORTED_DOC = "references/supported.md";

// Each language file in languages/ contributes its own stacks; the entries here span languages or
// describe the machine.
export const STACKS: Stack[] = [
  ...LANGUAGES.flatMap((l) => l.stacks),
  { id: "python-behind-root-package", label: "A Python app next to a root package.json", kind: "stack", tier: "not_yet", reason: "the app and the root package share the root folder, which the audit installs once, with Node's package manager", files: /\.(py|pyi)$/, proof: ["fixtures/python-behind-root-package", "saleor/saleor@dfbf139"] },
  { id: "task-graph", label: "A package that needs a sibling package built first", kind: "stack", tier: "not_yet", reason: "the audit builds packages one by one, not in Turbo's or Nx's order", proof: ["fixtures/turbo-depends-on-build", "spree/spree@cdd9a02"] },
  { id: "docker", label: "Docker", kind: "machine", tier: "supported", proof: ["tests/fixtures.test.ts"] },
  { id: "no-container", label: "No container runtime on Linux or macOS", kind: "machine", tier: "supported", reason: "nothing runs outside a container without the user's yes: Level 1 is unproven on this machine, and the report says why", proof: ["fixtures/declared-image-missing-toolchain", "fixtures/sudo-start", "tests/safety.test.ts"] },
  { id: "host-mode", label: "Host mode on Linux or macOS, with --allow-host", kind: "machine", tier: "supported", reason: "only on the user's yes; the repo's commands run in a copy with a throwaway home and no account credentials, but can read this user's local files, so Level 1 can't be proved there", proof: ["tests/safety.test.ts"] },
  { id: "windows", label: "Native Windows", kind: "machine", tier: "not_yet", reason: "the audit drives its container and host mode through bash; run it in WSL 2", proof: ["tests/supported.test.ts", "tests/safety.test.ts"] },
  { id: "podman", label: "Podman", kind: "machine", tier: "not_assessed", reason: "the audit drives it like Docker, but no fixture run has used it", proof: [] },
];

export function stack(id: string): Stack {
  const s = STACKS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stack ${id}`);
  return s;
}

export function supported(id: string): boolean {
  return stack(id).tier === "supported";
}

// The reason a component in this stack gets no level, for the report, where it follows "because"
// or a component's name.
export function notSupportedReason(id: string): string {
  const s = stack(id);
  return `${s.label.replace(/^A /, "a ")} isn't supported yet${s.reason ? `: ${s.reason}` : ""}`;
}

export const NOT_SUPPORTED = / isn't supported yet\b/;
