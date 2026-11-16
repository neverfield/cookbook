import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { discoverContract, imagePlan, toolSetup } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { go, goImage } from "../skill/agent-readiness/scripts/lib/languages/go.ts";
import { cfgActive, defaultFeatures, lockRoot, rust, rustCovered, rustImage, workspaceMembers } from "../skill/agent-readiness/scripts/lib/languages/rust.ts";
import { mirroredFolder, namedAfter } from "../skill/agent-readiness/scripts/lib/languages/coverage.ts";
import { allSites, targetFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { instructionItems } from "../skill/agent-readiness/scripts/lib/static.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";

const rubric = loadRubric(latestRubricVersion());
const goHooks = go.replay!;
const rustHooks = rust.replay!;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lang-go-rust-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const ops = (sites: { operator: string; after: string }[]) => sites.map((s) => [s.operator, s.after.trim()]);
const crate = (name: string) => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;

describe("Go", () => {
  test("runs in the first pinned golang image at or above the go line, or the toolchain line when higher", () => {
    const at = (mod: string) => goImage(repo({ "go.mod": mod }), ".");
    assert.equal(at("module x\n\ngo 1.22\n"), "golang:1.22-bookworm");
    assert.equal(at("module x\n\ngo 1.23.4\n"), "golang:1.23-bookworm");
    assert.equal(at("module x\n\ngo 1.16\n"), "golang:1.21-bookworm", "an older go line gets the oldest pinned Go, which builds it");
    assert.equal(at("module x\n\ngo 1.22\n\ntoolchain go1.25.3\n"), "golang:1.25-bookworm");
    assert.equal(at("module x\n"), "golang:1.27-bookworm", "no go line: the newest");
    assert.equal(at("module x\n\ngo 1.40\n"), "golang:1.27-bookworm");
    for (const tag of [at("module x\n\ngo 1.21\n"), at("module x\n")]) assert.match(goHooks.images[tag], /^sha256:[0-9a-f]{64}$/);
  });

  test("the go line pins the toolchain", () => {
    assert.deepEqual(goHooks.pins(repo({ "svc/go.mod": "module x\n\ngo 1.22\n" }), "svc"), { found: ["svc/go.mod"], missing: [] });
    assert.deepEqual(goHooks.pins(repo({ "go.mod": "module x\n" }), "."), { found: [], missing: ["the Go version (the go line in go.mod)"] });
  });

  test("a go.mod is scored with go build and go test, plus go vet where the repo runs it, in its own image next to a Node package", () => {
    const dir = repo({
      "package.json": '{"name":"web","scripts":{"test":"node --test"}}',
      "package-lock.json": "{}",
      "web.js": "",
      "api/go.mod": "module example.com/api\n\ngo 1.24\n",
      "api/stock/stock.go": "package stock\n",
      "api/stock/stock_test.go": "package stock\n",
      ".github/workflows/ci.yml": "jobs:\n  api:\n    steps:\n      - run: cd api && go vet ./... && go test ./...\n",
    });
    const profile = buildProfile(dir, dir, rubric);
    const api = profile.components.find((c) => c.path === "api")!;
    assert.deepEqual([api.assessed, api.language, api.packageManager], [true, "go", "go"]);
    assert.deepEqual(imagePlan(profile, dir).map((g) => g.image), ["node:22-bookworm", "golang:1.24-bookworm"]);
    const cmds = discoverContract(profile, dir, rubric, []).filter((c) => c.component === api.id).map((c) => [c.kind, c.command, c.cwd]);
    assert.deepEqual(cmds, [
      ["doctor", "go version", "."],
      ["install", "GOFLAGS=-mod=readonly go mod download", "api"],
      ["build", "go build ./...", "api"],
      ["lint", "go vet ./...", "api"],
      ["test", "go test -count=1 -v ./...", "api"],
    ]);
    assert.equal(discoverContract(profile, dir, rubric, []).find((c) => c.kind === "lint")!.source, ".github/workflows/ci.yml");
    const quiet = repo({ "go.mod": "module x\n\ngo 1.22\n", "x.go": "package x\n", "Makefile": "test:\n\tgo test ./...\n" });
    assert.deepEqual(discoverContract(buildProfile(quiet, quiet, rubric), quiet, rubric, []).map((c) => c.kind), ["doctor", "install", "build", "test"], "no lint where the repo runs no go vet");
  });

  test("faults go in the module's packages that have tests, never in a nested module, vendor/, testdata/ or generated code", () => {
    const dir = repo({
      "go.mod": "module x\n\ngo 1.22\n",
      "main.go": "package main\n",
      "stock/stock.go": "package stock\n",
      "stock/stock.pb.go": "package stock\n",
      "stock/stock_test.go": "package stock\n",
      "tools/go.mod": "module tools\n\ngo 1.22\n",
      "tools/gen.go": "package tools\n",
      "tools/gen_test.go": "package tools\n",
      "vendor/a/a.go": "package a\n",
      "vendor/a/a_test.go": "package a\n",
    });
    const comp = buildProfile(dir, dir, rubric).components.find((c) => c.assessed)!;
    assert.deepEqual(targetFiles(dir, comp), ["stock/stock.go"]);
  });

  test("fault sites: if without parentheses, after an init statement, and never in strings, comments or timings", () => {
    const sites = goHooks.mutation.sites!;
    assert.deepEqual(ops(sites("\tif reserved >= onHand {")), [["boundary_flip", "if reserved > onHand {"], ["negate_condition", "if !(reserved >= onHand) {"]]);
    assert.deepEqual(ops(sites("\tif v, ok := m[k]; ok {")), [["negate_condition", "if v, ok := m[k]; !(ok) {"]]);
    assert.deepEqual(ops(sites("\t} else if n > 10 { // more than 3")), [["boundary_flip", "} else if n >= 10 { // more than 3"], ["negate_condition", "} else if !(n > 10) { // more than 3"], ["change_constant", "} else if n > 11 { // more than 3"]]);
    assert.deepEqual(sites('\tx := "a > b 5" + `c 7`'), []);
    assert.deepEqual(sites("\ttime.Sleep(5 * time.Second)"), []);
    assert.deepEqual(sites('import "example.com/v2"'), []);
    const text = ["func a() string {", "\treturn `x", "y 3`", "}", "/* c", " 4 */", "var z = 1"].join("\n");
    assert.deepEqual([...goHooks.mutation.quoted!(text)].sort(), [1, 2, 4, 5]);
  });

  test("go test -v counts top-level tests; a compile error is told from a failing test", () => {
    const out = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n    --- PASS: TestB/sub (0.00s)\n--- FAIL: TestB (0.00s)\n    b_test.go:9: got 1, want 2\nFAIL\n";
    assert.deepEqual(goHooks.testCounts!(out), { passed: 1, failed: 1, total: 2 });
    assert.equal(goHooks.testCounts!("ok  \tx\t0.01s\n"), null);
    assert.equal(goHooks.mutation.compileError!(out), false);
    assert.equal(goHooks.mutation.compileError!("# x/stock\nstock/stock.go:5:2: undefined: y\nFAIL\tx/stock [build failed]\n"), true);
    assert.equal(goHooks.mutation.compileError!("./stock.go:5:2: syntax error: unexpected }\n"), true);
  });
});

describe("Rust", () => {
  test("runs in the pinned image of the release a toolchain file names, else the newest", () => {
    const at = (files: Record<string, string>, dir = ".") => rustImage(repo({ "Cargo.toml": crate("x"), ...files }), dir);
    assert.equal(at({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\n' }), "rust:1.95-bookworm");
    assert.equal(at({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.94"\n' }), "rust:1.94-bookworm");
    assert.equal(at({ "rust-toolchain": "1.93.0\n" }), "rust:1.93-bookworm", "the older plain-text file");
    assert.equal(at({ "rust-toolchain.toml": '[toolchain]\nchannel = "nightly-2026-06-01"\n' }), "rust:1.97-bookworm");
    assert.equal(at({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.70.0"\n' }), "rust:1.97-bookworm", "rustup adds an unpinned release during setup");
    assert.equal(at({}), "rust:1.97-bookworm");
    assert.equal(at({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.96"\n', "crates/a/Cargo.toml": crate("a") }, "crates/a"), "rust:1.96-bookworm", "rustup reads the file from the crate's folder up");
  });

  test("the toolchain file pins the toolchain, and setup adds clippy to the toolchain it names where the repo runs clippy", () => {
    const dir = repo({ "Cargo.toml": crate("x"), "rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\ncomponents = ["clippy"]\n' });
    assert.deepEqual(rustHooks.pins(dir, "."), { found: ["rust-toolchain.toml"], missing: [] });
    assert.deepEqual(rustHooks.pins(repo({ "Cargo.toml": crate("x") }), "."), { found: [], missing: ["the Rust toolchain (rust-toolchain.toml)"] });
    assert.deepEqual(toolSetup(buildProfile(dir, dir, rubric), dir), [{ tool: "clippy", spec: "clippy for Rust 1.95.0", install: "rustup component add clippy" }]);
    const none = repo({ "Cargo.toml": crate("x") });
    assert.deepEqual(toolSetup(buildProfile(none, none, rubric), none), [], "no clippy where the repo runs none");
    for (const [file, text] of [["clippy.toml", ""], [".github/workflows/ci.yml", "- run: cargo +stable clippy --all-targets -- -D warnings\n"], ["justfile", "lint:\n    cargo clippy --workspace\n"]]) {
      const declared = repo({ "Cargo.toml": crate("x"), [file]: text });
      assert.equal(discoverContract(buildProfile(declared, declared, rubric), declared, rubric, []).find((c) => c.kind === "lint")?.source, file, `${file} declares clippy`);
    }
  });

  test("a workspace's members share the root's Cargo.lock, and the root component runs every member", () => {
    const files = { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n', "Cargo.lock": "version = 4\n", "clippy.toml": "", "crates/a/Cargo.toml": crate("a"), "crates/b/Cargo.toml": crate("b"), "crates/legacy/Cargo.toml": crate("legacy") };
    const dir = repo(files);
    assert.equal(lockRoot(dir, "crates/a"), ".");
    assert.deepEqual(ecosystemOf("cargo")!.install(dir, "crates/a", { ignoreScripts: false }), { command: "cargo fetch --locked", reason: "frozen fetch from the workspace's Cargo.lock in .", frozen: true });
    assert.equal(ecosystemOf("cargo")!.unpinned(dir, "crates/a"), null);
    const { "Cargo.lock": _lock, ...unlocked } = files;
    assert.equal(ecosystemOf("cargo")!.unpinned(repo(unlocked), "crates/a"), "no Cargo.lock is committed");
    assert.deepEqual(workspaceMembers(dir, "."), ["crates/a", "crates/b"]);
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(profile.components.map((c) => [c.path, c.assessed]), [[".", true]]);
    const cmds = discoverContract(profile, dir, rubric, []).filter((c) => c.kind !== "doctor").map((c) => c.command);
    assert.deepEqual(cmds, ["cargo fetch --locked", "cargo build --locked --workspace", "cargo clippy --locked --offline --workspace", "cargo test --locked --offline -q --workspace"]);
    const lone = repo({ "Cargo.toml": crate("x"), "Cargo.lock": "version = 4\n" });
    assert.equal(discoverContract(buildProfile(lone, lone, rubric), lone, rubric, []).find((c) => c.kind === "test")!.command, "cargo test --locked --offline -q");
  });

  test("faults go only in member source files that hold their own tests, never in their test modules", () => {
    const withTests = "pub fn f(n: u8) -> bool {\n    if n > 3 {\n        return true;\n    }\n    false\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert!(super::f(4) == true); }\n}\n";
    const dir = repo({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n',
      "Cargo.lock": "",
      "crates/a/Cargo.toml": crate("a"),
      "crates/a/src/lib.rs": withTests,
      "crates/a/src/plain.rs": "pub fn g() -> u8 { 1 }\n",
      "crates/a/tests/it.rs": withTests,
      "crates/a/build.rs": withTests,
      "crates/legacy/Cargo.toml": crate("legacy"),
      "crates/legacy/src/lib.rs": withTests,
      "fuzz/Cargo.toml": crate("fuzz"),
      "fuzz/src/lib.rs": withTests,
    });
    const comp = buildProfile(dir, dir, rubric).components.find((c) => c.assessed)!;
    assert.deepEqual(targetFiles(dir, comp), ["crates/a/src/lib.rs"]);
    assert.deepEqual(allSites(dir, ["crates/a/src/lib.rs"], "rust").map((s) => s.line), [2, 2, 2, 3], "no site in the #[cfg(test)] module");
  });

  test("fault sites: lifetimes and char literals aren't strings, if let isn't negated, attributes and use lines have none", () => {
    const sites = rustHooks.mutation.sites!;
    assert.deepEqual(ops(sites("    fn f<'a>(x: &'a str) -> bool { x.len() > 3 }")), [["boundary_flip", "fn f<'a>(x: &'a str) -> bool { x.len() >= 3 }"], ["change_constant", "fn f<'a>(x: &'a str) -> bool { x.len() > 4 }"]]);
    assert.deepEqual(ops(sites("    while i < n {")), [["boundary_flip", "while i <= n {"], ["negate_condition", "while !(i < n) {"]]);
    assert.deepEqual(sites("    if let Some(x) = y {"), []);
    assert.deepEqual(sites("    let c = '{'; let s = r#\"x > 5\"#;"), []);
    assert.deepEqual(sites("#[derive(Debug)]"), []);
    assert.deepEqual(sites("pub(crate) use std::io;"), []);
    assert.deepEqual(ops(sites("    let n = 1_000 + 2;")), [["change_constant", "let n = 1_000 + 3;"]]);
    const text = ["pub fn a() -> u32 {", "    /* block", "       2 */", '    let s = "multi', 'line 3";', "    5", "}", "#[cfg(test)]", "mod tests {", "    fn t() {}", "}", "#[cfg(test)]", "use foo;", "fn b() -> u8 { 1 }"].join("\n");
    assert.deepEqual([...rustHooks.mutation.quoted!(text)].sort((a, b) => a - b), [1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
  });

  test("test counts sum every test binary; a compile error is told from a failing test", () => {
    const out = "running 3 tests\n...\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nrunning 2 tests\n.F\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n\nerror: test failed, to rerun pass `--lib`\n";
    assert.deepEqual(rustHooks.testCounts!(out), { passed: 4, failed: 1, total: 5 });
    assert.equal(rustHooks.mutation.compileError!(out), false);
    assert.equal(rustHooks.mutation.compileError!("error[E0308]: mismatched types\n --> src/lib.rs:3:5\n"), true);
    assert.equal(rustHooks.mutation.compileError!("error: expected `;`, found `}`\nerror: could not compile `a` (lib) due to 1 previous error\n"), true);
  });
});

describe("instructions once Go and Rust are scored", () => {
  test("their commands, and Make targets that run them, are steps to replay", () => {
    const items = (files: Record<string, string>) => {
      const dir = repo(files);
      return new Map(instructionItems(dir, buildProfile(dir, dir, rubric)).map((i) => [`${i.line} ${i.text}`, i.category]));
    };
    const goRepo = items({ "go.mod": "module x\n\ngo 1.22\n", "x.go": "package x\n", Makefile: "test:\n\tgo test ./...\n", "CONTRIBUTING.md": "Run `go test ./...` or `make test`.\n" });
    assert.deepEqual([goRepo.get("1 go test ./..."), goRepo.get("1 make test")], ["replay", "replay"]);
    const rustRepo = items({ "Cargo.toml": crate("x"), "Cargo.lock": "", "src/lib.rs": "", "CONTRIBUTING.md": "Run `cargo test`.\n" });
    assert.equal(rustRepo.get("1 cargo test"), "replay");
  });
});

describe("fault targets for tests that don't sit in or name their source (final review H4)", () => {
  test("a crate tested only from tests/*.rs, as dtolnay/semver and serde-rs/json are, gets faults in the sources it compiles", () => {
    const dir = repo({
      "Cargo.toml": crate("semver"),
      "Cargo.lock": "",
      "src/lib.rs": "mod parse;\nmod eval;\n#[cfg(feature = \"serde\")]\nmod serde;\npub fn major(v: u64) -> u64 {\n    if v > 0 {\n        return v;\n    }\n    0\n}\n",
      "src/parse.rs": "pub fn digits(s: &str) -> usize {\n    s.len() + 1\n}\n",
      "src/eval.rs": "#![cfg(feature = \"eval\")]\npub fn cmp(a: u64, b: u64) -> bool {\n    a < b\n}\n",
      "src/serde.rs": "pub fn ser(a: u64) -> u64 {\n    a + 1\n}\n",
      "tests/test_version.rs": "#[test]\nfn t() { assert_eq!(semver::major(1), 1); }\n",
      "tests/node/mod.rs": "pub fn helper() {}\n",
    });
    const comp = buildProfile(dir, dir, rubric).components.find((c) => c.assessed)!;
    assert.deepEqual(targetFiles(dir, comp), ["src/lib.rs", "src/parse.rs"], "not the serde module or the eval file, which default features leave out");
    const featured = repo({ "Cargo.toml": `${crate("x")}\n[features]\ndefault = ["std"]\nstd = ["serde", "dep:other", "other/std"]\nserde = []\neval = []\n`, "src/lib.rs": "#[cfg(feature = \"serde\")]\nmod serde;\n#[cfg(not(feature = \"eval\"))]\nmod plain;\n", "src/serde.rs": "", "src/plain.rs": "", "tests/t.rs": "" });
    assert.deepEqual([...defaultFeatures(featured, ".")].sort(), ["serde", "std"]);
    assert.deepEqual(rustCovered(featured, ".", ["tests/t.rs"], ["src/lib.rs", "src/serde.rs", "src/plain.rs"]), ["src/lib.rs", "src/plain.rs", "src/serde.rs"], "default features turn serde on and leave eval off");
  });

  test("a crate with inline tests keeps them as its targets, and a tests.rs module is test code", () => {
    const dir = repo({
      "Cargo.toml": crate("x"),
      "src/lib.rs": "pub fn f() -> u8 { 1 }\n#[cfg(test)]\nmod tests;\n",
      "src/tests.rs": "#[test]\nfn t() { assert_eq!(super::f(), 1); }\n",
      "src/inline.rs": "pub fn g(n: u8) -> bool {\n    n > 3\n}\n#[cfg(test)]\nmod t {}\n",
      "src/other.rs": "pub fn h() -> u8 { 2 }\n",
      "tests/it.rs": "",
    });
    assert.equal(rust.replay!.mutation.isTest("src/tests.rs"), true);
    assert.deepEqual(rustCovered(dir, ".", ["src/tests.rs", "tests/it.rs"], ["src/lib.rs", "src/tests.rs", "src/inline.rs", "src/other.rs"]), ["src/inline.rs", "src/lib.rs"]);
  });

  test("an item under a cfg that isn't on everywhere gets no fault: features, other platforms, architectures", () => {
    const text = ["pub fn a(n: u64) -> bool {", "    n > 3", "}", "#[cfg(feature = \"float_roundtrip\")]", "fn b(n: u64) -> bool {", "    n > 4", "}", "#[cfg(windows)]", "fn c() -> u8 { 5 }", "#[cfg(unix)]", "fn d() -> u8 { 6 }", "#[cfg(target_arch = \"x86_64\")]", "fn e() -> u8 { 7 }", "#[cfg_attr(test, derive(Debug))]", "struct S(u8);"].join("\n");
    assert.deepEqual([...rust.replay!.mutation.quoted!(text)].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 11, 12]);
    assert.equal(cfgActive('all(unix, not(target_os = "macos"))', null), true);
    assert.equal(cfgActive('any(feature = "std", windows)', new Set(["std"])), true);
    assert.equal(cfgActive('feature = "std"', null), null);
    assert.equal(cfgActive("target_pointer_width = \"64\"", new Set()), null, "differs between machines, so never a fault site");
  });

  test("namedAfter: when no test names a source, a test covers a folder it names, else its mirrored folder", () => {
    const isSource = (f: string) => /\.(rb|cs|java|php)$/.test(f) && !/(_spec|Tests?)\.\w+$/.test(f);
    const rb = ["lib/jwt/encode.rb", "lib/jwt/decode.rb", "lib/other.rb"];
    assert.deepEqual(namedAfter(["spec/jwt_spec.rb"], rb, isSource), ["lib/jwt/decode.rb", "lib/jwt/encode.rb"], "jwt_spec covers lib/jwt/");
    const cs = ["src/Shop/Orders/Order.cs", "src/Shop/Orders/Cart.cs", "src/Shop/Pricing/Tax.cs", "src/Other/Thing.cs"];
    assert.deepEqual(namedAfter(["tests/Shop.Tests/Orders/IntegrationTests.cs"], cs, isSource), ["src/Shop/Orders/Cart.cs", "src/Shop/Orders/Order.cs"]);
    assert.deepEqual(namedAfter(["tests/Shop.Tests/IntegrationTests.cs"], cs, isSource), ["src/Shop/Orders/Cart.cs", "src/Shop/Orders/Order.cs", "src/Shop/Pricing/Tax.cs"], "nothing directly in Shop, so what is under it");
    const java = ["gson/src/main/java/com/google/gson/internal/bind/JsonTreeReader.java", "gson/src/main/java/com/google/gson/Gson.java"];
    assert.deepEqual(namedAfter(["gson/src/test/java/com/google/gson/internal/bind/RecursiveTypesResolveTest.java"], java, isSource), ["gson/src/main/java/com/google/gson/internal/bind/JsonTreeReader.java"]);
    const php = ["src/Http/Client.php", "src/Http/Request.php", "src/Cache.php"];
    assert.deepEqual(namedAfter(["tests/Unit/Http/RetryTest.php"], php, isSource), ["src/Http/Client.php", "src/Http/Request.php"]);
    assert.equal(mirroredFolder("tests/Feature/Api/UserTest.php"), mirroredFolder("app/Api/User.php"));
  });

  test("namedAfter: a component whose tests name their sources keeps exactly those, as symfony/demo and Shopify/packwerk do", () => {
    const isSource = (f: string) => /\.(rb|php)$/.test(f) && !/(_spec|_test|Test)\.\w+$/.test(f);
    const php = ["src/Http/Client.php", "src/Http/Request.php", "src/Cache.php"];
    assert.deepEqual(namedAfter(["tests/Unit/Http/RetryTest.php", "tests/Unit/CacheTest.php"], php, isSource), ["src/Cache.php"], "CacheTest names Cache.php, so RetryTest adds no folder");
    assert.deepEqual(namedAfter(["spec/order_spec.rb"], ["app/models/order.rb", "app/models/cart.rb"], isSource), ["app/models/order.rb"]);
    assert.deepEqual(namedAfter(["spec/jwt_spec.rb"], ["lib/jwt.rb", "lib/jwt/encode.rb"], isSource), ["lib/jwt.rb"]);
  });
});
