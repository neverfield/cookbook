import { join } from "node:path";
import { exists, listFiles, readText } from "../util.ts";
import type { LanguageDef } from "./language.ts";

// Recognized and listed with their share of changes, and not scored in this release. No language
// group owns these; give one its own file when it gets scored.

// The file git tracks inside an Xcode project or workspace folder, which the scan takes as its manifest.
const XCODE = /^([^/]+)\.(xcodeproj|xcworkspace)\/(project\.pbxproj|contents\.xcworkspacedata)$/;

// What an Xcode app's files say about its dependencies and Xcode version, read without running.
function xcodeNotes(tree: string, dir: string): string[] {
  const at = (f: string) => join(tree, dir, f);
  const files = listFiles(join(tree, dir));
  const out: string[] = [];
  if (exists(at("Podfile"))) out.push(exists(at("Podfile.lock")) ? "Podfile.lock is committed for its CocoaPods" : "it has a Podfile and no committed Podfile.lock");
  if (exists(at("Cartfile"))) out.push(exists(at("Cartfile.resolved")) ? "Cartfile.resolved is committed for its Carthage dependencies" : "it has a Cartfile and no committed Cartfile.resolved");
  const spm = files.some((f) => /\.xcodeproj\/project\.pbxproj$/.test(f) && /XCRemoteSwiftPackageReference/.test(readText(join(tree, dir, f))));
  if (spm) out.push(files.some((f) => /\.(xcodeproj|xcworkspace)\/.*\/swiftpm\/Package\.resolved$/.test(f)) ? "Package.resolved is committed for its Swift packages" : "it uses Swift packages and commits no Package.resolved");
  out.push(exists(at(".xcode-version")) || exists(join(tree, ".xcode-version")) ? ".xcode-version pins the Xcode version" : "no .xcode-version pins the Xcode version");
  return out;
}

export const swift: LanguageDef = {
  id: "swift",
  label: "Swift",
  codes: [],
  stacks: [
    { id: "swift", label: "Swift", kind: "stack", tier: "not_assessed", files: /\.swift$/, proof: ["fixtures/swift-package", "apple/swift-argument-parser@38ca4ec"] },
    {
      id: "xcode",
      label: "An Xcode app (iOS or macOS)",
      kind: "stack",
      tier: "not_yet",
      needs: "macOS with Xcode",
      reason: "it needs macOS with Xcode, since only xcodebuild on a Mac builds and tests it, and the audit's containers run Linux, so it's blocked on this machine rather than broken",
      files: /\.(swift|m|mm|h|storyboard|xib|plist|xcconfig|entitlements|strings)$|\.(xcodeproj|xcworkspace|xcassets)\/|(^|\/)(Podfile(\.lock)?|Cartfile(\.resolved)?)$/,
      proof: ["fixtures/ios-xcode", "fixtures/dotnet-ios-monorepo", "kickstarter/ios-oss@2090757"],
    },
  ],
  detect: {
    // An app's workspace or project claims its folder before a Package.swift next to it does, and
    // before a Gemfile, which next to an Xcode project holds fastlane or CocoaPods.
    manifests: [
      { match: /\.xcworkspace$/, stack: "xcode", rank: 44 },
      { match: /\.xcodeproj$/, stack: "xcode", rank: 45 },
      { match: /^Package\.swift$/, stack: "swift", rank: 70 },
    ],
    sources: [{ ext: /\.swift$/, stack: "swift", rank: 80 }],
    // CocoaPods' too, for an Xcode project.
    lockfiles: ["Package.resolved", "Podfile.lock"],
    projectName: (_tree, manifest, text) => (manifest === "Package.swift" ? text.match(/\bname:\s*"([^"]+)"/)?.[1] : manifest.match(XCODE)?.[1]),
    notes: (tree, dir, stackId) => (stackId === "xcode" ? xcodeNotes(tree, dir) : []),
  },
  ecosystems: [],
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: null,
    countedTests: null,
    ciTest: null,
  },
  mutation: null,
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
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: null,
    countedTests: null,
    ciTest: null,
  },
  mutation: null,
};

export const elixir: LanguageDef = {
  id: "elixir",
  label: "Elixir",
  codes: [],
  stacks: [{ id: "elixir", label: "Elixir", kind: "stack", tier: "not_assessed", files: /\.(ex|exs|heex)$|(^|\/)mix\.(exs|lock)$/, proof: ["tests/discovery.test.ts"] }],
  detect: {
    manifests: [{ match: /^mix\.exs$/, stack: "elixir", rank: 80 }],
    sources: [{ ext: /\.exs?$/, stack: "elixir", rank: 85 }],
    lockfiles: ["mix.lock"],
    projectName: (_tree, manifest, text) => (manifest === "mix.exs" ? text.match(/\bapp:\s*:(\w+)/)?.[1] : undefined),
  },
  ecosystems: [],
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: null,
    countedTests: null,
    ciTest: null,
  },
  mutation: null,
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
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: null,
    countedTests: null,
    ciTest: null,
  },
  mutation: null,
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
  checks: {
    weakening: { isTest: null, markers: null },
    lockfiles: { diff: null, secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: null,
    countedTests: null,
    ciTest: null,
  },
  mutation: null,
};
