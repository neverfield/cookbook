import type { LanguageDef } from "./language.ts";

// Recognized and listed with their share of changes, and not scored in this release. No language
// group owns these; give one its own file when it gets scored.

export const swift: LanguageDef = {
  id: "swift",
  label: "Swift",
  codes: [],
  stacks: [{ id: "swift", label: "Swift", kind: "stack", tier: "not_assessed", files: /\.swift$/, proof: ["fixtures/swift-package", "apple/swift-argument-parser@38ca4ec"] }],
  detect: {
    manifests: [{ match: /^Package\.swift$/, stack: "swift", rank: 70 }],
    sources: [{ ext: /\.swift$/, stack: "swift", rank: 80 }],
    lockfiles: ["Package.resolved"],
    projectName: (_tree, manifest, text) => (manifest === "Package.swift" ? text.match(/\bname:\s*"([^"]+)"/)?.[1] : undefined),
  },
  ecosystems: [],
};

export const dart: LanguageDef = {
  id: "dart",
  label: "Dart",
  codes: [],
  stacks: [{ id: "dart", label: "Dart", kind: "stack", tier: "not_assessed", files: /\.dart$|(^|\/)pubspec\.(yaml|lock)$/, proof: ["fixtures/dart-packages", "dart-lang/http@8c0d66a"] }],
  detect: {
    manifests: [{ match: /^pubspec\.yaml$/, stack: "dart", rank: 80 }],
    sources: [{ ext: /\.dart$/, stack: "dart", rank: 90 }],
    lockfiles: ["pubspec.lock"],
    projectName: (_tree, manifest, text) => (manifest === "pubspec.yaml" ? text.match(/^name:\s*['"]?([\w-]+)/m)?.[1] : undefined),
    // A Dart workspace's root pubspec only lists its packages; each package is the project.
    workspaceOnly: (manifest, text) => manifest.endsWith("pubspec.yaml") && /^workspace:/m.test(text),
  },
  ecosystems: [],
};

// A folder of .tf files is a Terraform module, so a root module and nested root modules are found
// at any depth.
export const terraform: LanguageDef = {
  id: "terraform",
  label: "Terraform",
  codes: [],
  stacks: [{ id: "terraform", label: "Terraform", kind: "stack", tier: "not_assessed", files: /\.(tf|tfvars)$/, proof: ["fixtures/terraform-modules", "fixtures/monorepo-mixed", "terraform-aws-modules/terraform-aws-vpc@b3abd6d"] }],
  detect: {
    manifests: [{ match: /\.tf$/, stack: "terraform", rank: 90 }],
    sources: [{ ext: /\.tf$/, stack: "terraform", rank: 10 }],
    lockfiles: [".terraform.lock.hcl"],
  },
  ecosystems: [],
};

// Found by its build file only: a .c or .cc file next to a Node addon or a Python extension is part
// of that package, not a project of its own.
export const cpp: LanguageDef = {
  id: "cpp",
  label: "C and C++",
  codes: [],
  stacks: [{ id: "cpp", label: "C or C++", kind: "stack", tier: "not_assessed", reason: "the audit recognizes it and doesn't score it in this release, since builds vary too much between CMake, Meson and Make for one install and test rule", files: /\.(c|cc|cpp|cxx|h|hh|hpp)$|(^|\/)(CMakeLists\.txt|meson\.build)$/, proof: ["fixtures/cpp-cmake"] }],
  detect: {
    manifests: [{ match: /^(CMakeLists\.txt|meson\.build)$/, stack: "cpp", rank: 85 }],
  },
  ecosystems: [],
};
