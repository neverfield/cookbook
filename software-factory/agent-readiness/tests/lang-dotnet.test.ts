import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { discoverContract, imagePlan } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { IMAGE_SDK, SDKS, dotnet, dotnetTestCounts, sdkFor, sdkSatisfies, windowsOnly } from "../skill/agent-readiness/scripts/lib/languages/dotnet.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { targetFiles, testFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { environmentLimit } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ContractCommand } from "../skill/agent-readiness/scripts/lib/types.ts";
import { FIXTURES } from "../support/tools/fixture.ts";

const rubric = loadRubric(latestRubricVersion());
const hooks = dotnet.replay!;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dotnet-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const proj = (tfm: string, refs = "") => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework></PropertyGroup><ItemGroup>${refs}</ItemGroup></Project>`;
const XUNIT = '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" /><PackageReference Include="xunit" Version="2.9.3" />';

describe(".NET: the SDK image", () => {
  test("the SDK global.json pins, else the newest target framework, else .NET 8; each image is pinned", () => {
    assert.deepEqual(SDKS, [8, 9, 10]);
    assert.equal(sdkFor(repo({ "global.json": '{"sdk":{"version":"9.0.100"}}', "A.csproj": proj("net8.0") }), "."), 9);
    assert.equal(sdkFor(repo({ "A.csproj": "<Project><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>" }), "."), 10);
    assert.equal(sdkFor(repo({ "A.csproj": proj("netstandard2.0") }), "."), 8);
    assert.equal(sdkFor(repo({ "src/A/A.csproj": proj("net8.0"), "global.json": '{"sdk":{"version":"10.0.100"}}' }), "src/A"), 10, "a root global.json applies to a nested project");
    for (const v of SDKS) assert.match(hooks.images[`mcr.microsoft.com/dotnet/sdk:${v}.0`] ?? "", /^sha256:[0-9a-f]{64}$/);
  });

  test("the toolchain condition is the sdk version in global.json", () => {
    assert.deepEqual(hooks.pins(repo({ "global.json": '{"sdk":{"version":"8.0.100"}}' }), "."), { found: ["global.json"], missing: [] });
    assert.deepEqual(hooks.pins(repo({ "A.csproj": proj("net8.0") }), ".").missing, ["the .NET SDK version (the sdk version in global.json)"]);
  });
});

describe(".NET: an SDK global.json pins that the image doesn't ship", () => {
  test("rollForward decides whether the image's SDK will do, as the .NET host decides it", () => {
    assert.equal(sdkSatisfies("10.0.404", "10.0.100"), false, "the default patch policy stays in the 1xx feature band");
    assert.equal(sdkSatisfies("10.0.404", "10.0.400"), true);
    assert.equal(sdkSatisfies("10.0.404", "10.0.405"), false);
    assert.equal(sdkSatisfies("8.0.428", "8.0.100", "latestFeature"), true);
    assert.equal(sdkSatisfies("8.0.428", "8.0.100", "feature"), true);
    assert.equal(sdkSatisfies("9.0.321", "8.0.100", "latestFeature"), false, "a feature roll-forward never changes the minor");
    assert.equal(sdkSatisfies("9.0.321", "8.0.100", "major"), true);
    assert.equal(sdkSatisfies("10.0.404", "10.0.404", "disable"), true);
    assert.equal(sdkSatisfies("10.0.404", "10.0.403", "disable"), false);
  });

  test("the pinned SDK is added from Microsoft's install script only when the image's doesn't satisfy global.json", () => {
    assert.deepEqual(IMAGE_SDK, { 8: "8.0.428", 9: "9.0.321", 10: "10.0.404" });
    const strict = repo({ "global.json": '{"sdk":{"version":"10.0.100"}}', "A.csproj": proj("net10.0") });
    const [t] = hooks.setup!(strict, ".");
    assert.equal(t.spec, "dotnet-sdk@10.0.100");
    assert.match(t.install, /dotnet-install\.sh --version 10\.0\.100 --install-dir \/usr\/share\/dotnet --no-path/);
    assert.deepEqual(hooks.setup!(join(FIXTURES, "dotnet-xunit", "repo"), "."), [], "8.0.100 with latestFeature runs on the image's 8.0.428");
    assert.deepEqual(hooks.setup!(repo({ "A.csproj": proj("net8.0") }), "."), [], "nothing pinned, nothing added");
  });
});

describe(".NET: a NativeAOT project needs the platform's C toolchain", () => {
  // serilog/serilog@43105b3's test/AotTestApp: PublishAot, published on every build.
  const AOT_APP = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><PublishAot>true</PublishAot></PropertyGroup><Target Name="PublishOnBuild" AfterTargets="Build" DependsOnTargets="Publish" /></Project>';
  const cmd = (kind: ContractCommand["kind"]): ContractCommand => ({ id: `cmd-Serilog-${kind}`, kind, component: "Serilog", cwd: ".", command: "dotnet build", source: "readiness", reason: "x", timeoutSec: 1200 });
  const auditImage = { where: "container" as const, image: "mcr.microsoft.com/dotnet/sdk:10.0", imageSource: "audit" as const };

  test("the setup adds the older runtimes the tests target, and clang and zlib1g-dev (Microsoft's Linux prerequisites) only when a project publishes with NativeAOT", () => {
    const tests = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks Condition=" '$(OS)' == 'Windows_NT'">net48;net462</TargetFrameworks><TargetFrameworks>$(TargetFrameworks);net10.0;net9.0;net8.0</TargetFrameworks></PropertyGroup><ItemGroup>${XUNIT}</ItemGroup></Project>`;
    const serilogLike = repo({ "Serilog.sln": "", "global.json": '{"sdk":{"version":"10.0.100","rollForward":"latestFeature"}}', "src/Serilog/Serilog.csproj": proj("net10.0"), "test/Serilog.Tests/Serilog.Tests.csproj": tests, "test/AotTestApp/AotTestApp.csproj": AOT_APP });
    const setup = hooks.setup!(serilogLike, ".");
    assert.deepEqual(setup.map((t) => [t.tool, t.spec]), [
      ["dotnet-runtime-8.0", ".NET 8.0 runtime"],
      ["dotnet-runtime-9.0", ".NET 9.0 runtime"],
      ["clang", "clang and zlib1g-dev (for NativeAOT)"],
    ], "10.0.100 with latestFeature runs on the image's 10.0.404; the tests also run on net8.0 and net9.0, and the Windows-only net48 is left out");
    assert.match(setup[0].install, /dotnet-install\.sh --runtime dotnet --channel 8\.0 --install-dir \/usr\/share\/dotnet --no-path/);
    assert.match(setup[2].install, /apt-get install -y -qq --no-install-recommends clang zlib1g-dev/);
    assert.deepEqual(hooks.setup!(repo({ "A.csproj": proj("net10.0") }), "."), []);
  });

  test("a missing native linker is a missing tool, blocked in the audit's image and the repo's to fix in its own", () => {
    // The build lines of serilog@43105b3 in the pinned sdk:10.0 image without a linker (GitHub runner).
    const real = readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", "dotnet-nativeaot-no-linker.txt"), "utf8");
    const want = { cause: "missing_tool", detail: "clang or gcc, the native linker NativeAOT needs, is not installed" };
    for (const kind of ["build", "test"] as const) {
      const d = diagnose(real, false, kind);
      assert.deepEqual(d, want, `${kind}: the test run builds the AOT project too, so it fails the same way after its tests pass`);
      assert.equal(environmentLimit(auditImage, cmd(kind), d, []), "clang or gcc, the native linker NativeAOT needs, is not installed in the audit's image (mcr.microsoft.com/dotnet/sdk:10.0)");
      assert.equal(environmentLimit({ ...auditImage, imageSource: "repo" }, cmd(kind), d, []), undefined);
    }
    const line = "/usr/share/dotnet/sdk/10.0.404/Sdks/Microsoft.DotNet.ILCompiler/build/Microsoft.NETCore.Native.Unix.targets(316,5): error : Platform linker ('clang' or 'gcc') not found in PATH. Ensure you have all the required prerequisites documented at https://aka.ms/nativeaot-prerequisites. [/work/test/AotTestApp/AotTestApp.csproj]";
    assert.deepEqual(diagnose(line, false, "build"), want, "the line the Mac's serilog golden run printed");
    assert.equal(diagnose("Microsoft.NETCore.Native.Unix.targets(400,5): error : Symbol stripping tool ('objcopy' or 'llvm-objcopy') not found in PATH.", false, "build").detail, "objcopy, which NativeAOT strips symbols with, is not installed");
  });
});

describe(".NET: the contract", () => {
  test("a locked restore, a build, and the test run offline, in the pinned SDK's image", () => {
    const dir = join(FIXTURES, "dotnet-xunit", "repo");
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(profile.components.map((c) => [c.id, c.language, c.packageManager, c.assessed]), [["Billing", "csharp", "nuget", true]]);
    assert.deepEqual(discoverContract(profile, dir, rubric, []).map((c) => [c.kind, c.command]), [
      ["doctor", "dotnet --version"],
      ["install", "dotnet restore --locked-mode"],
      ["build", "dotnet build --no-restore"],
      ["test", "dotnet test --no-restore"],
    ]);
    assert.deepEqual(imagePlan(profile, dir).slice(1), [{ image: "mcr.microsoft.com/dotnet/sdk:8.0", components: ["Billing"] }]);
  });

  test("a folder with several solutions names the one the component is, for every command", () => {
    const dir = repo({ "Shop.sln": "", "Shop.Tools.sln": "", "src/Shop.csproj": proj("net8.0"), "tests/Shop.Tests.csproj": proj("net8.0", XUNIT) });
    assert.equal(ecosystemOf("nuget")!.install(dir, ".", { ignoreScripts: false }).command, "dotnet restore Shop.sln");
    assert.deepEqual(hooks.commands(dir, { path: "." } as never).map((c) => c.command), ["dotnet build Shop.sln --no-restore", "dotnet test Shop.sln --no-restore"]);
    assert.equal(hooks.mutation.compileProbe({ path: "services/shop", manifest: "services/shop/Shop.sln" } as never)!.command, "dotnet build Shop.sln --no-restore -v q -nologo");
  });

  test("no test project, no test command: a folder without the test SDK or a framework has no tests to run", () => {
    const dir = repo({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>' });
    assert.deepEqual(hooks.commands(dir, { path: "." } as never).map((c) => c.kind), ["build"]);
    for (const ref of ['<PackageReference Include="NUnit" Version="4.0.1" />', '<PackageReference Include="MSTest" Version="3.6.0" />', "<IsTestProject>true</IsTestProject>"]) {
      assert.deepEqual(hooks.commands(repo({ "T.csproj": proj("net8.0", ref) }), { path: "." } as never).map((c) => c.kind), ["build", "test"], ref);
    }
  });

  test("test counts from VSTest, summed over test projects, and from Microsoft.Testing.Platform", () => {
    const vstest = [
      "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 16 ms - Billing.Tests.dll (net8.0)",
      "Failed!  - Failed:     1, Passed:     4, Skipped:     1, Total:     6, Duration: 20 ms - Other.Tests.dll (net8.0)",
    ].join("\n");
    assert.deepEqual(dotnetTestCounts(vstest), { passed: 7, failed: 1, total: 8 });
    assert.deepEqual(dotnetTestCounts("Test run summary: Passed!\n  total: 5\n  failed: 0\n  succeeded: 5\n  skipped: 0\n"), { passed: 5, failed: 0, total: 5 });
    assert.equal(dotnetTestCounts("Build succeeded."), null);
  });
});

describe(".NET: where faults go", () => {
  test("into the sources a test class is named after, never into generated code or tests", () => {
    const dir = join(FIXTURES, "dotnet-xunit", "repo");
    const comp = buildProfile(dir, dir, rubric).components[0];
    assert.deepEqual(testFiles(dir, comp), ["tests/Billing.Tests/InvoiceTests.cs"]);
    assert.deepEqual(targetFiles(dir, comp), ["src/Billing/Invoice.cs"]);
    for (const f of ["src/A/obj/Debug/A.AssemblyInfo.cs", "src/A/Form1.Designer.cs", "src/A/Migrations/0001_Init.cs", "tests/A.Tests/ATests.cs"]) assert.ok(!hooks.mutation.isSource(f), f);
    assert.ok(hooks.mutation.compileError!("Invoice.cs(14,20): error CS0103: The name 'zero' does not exist in the current context"));
    assert.ok(!hooks.mutation.compileError!("Failed!  - Failed:     1, Passed:     2"));
  });
});

describe(".NET: projects that need Windows", () => {
  const legacy = '<?xml version="1.0"?><Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>';

  test("the pre-SDK format, .NET Framework or -windows targets, Windows Forms, WPF and packages.config need Windows; modern targets don't", () => {
    assert.equal(windowsOnly(legacy, false), "pre-SDK .NET Framework 4.8 format");
    assert.equal(windowsOnly(proj("net48"), false), "net48");
    assert.equal(windowsOnly(proj("net8.0-windows"), false), "net8.0-windows");
    assert.equal(windowsOnly('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><UseWPF>true</UseWPF></PropertyGroup></Project>', false), "WPF");
    assert.equal(windowsOnly(proj("net8.0"), true), "packages.config");
    for (const ok of [proj("net8.0"), proj("netstandard2.0"), "<Project><PropertyGroup><TargetFrameworks>net48;net8.0</TargetFrameworks></PropertyGroup></Project>", "<Project></Project>"]) assert.equal(windowsOnly(ok, false), null, ok);
  });

  test("a solution of Windows-only projects is one component that needs Windows, runs nothing, and says what its files pin", () => {
    const dir = join(FIXTURES, "dotnet-framework-windows", "repo");
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(profile.components.map((c) => [c.id, c.stack, c.assessed]), [["Ledger", "dotnet-windows", false]]);
    const reason = profile.components[0].notAssessedReason!;
    assert.match(reason, /it needs Windows/);
    assert.match(reason, /blocked on this machine rather than broken/);
    assert.match(reason, /Ledger\.Core \(net48\), Ledger\.Desktop, Ledger\.Tests and Ledger\.Web \(pre-SDK \.NET Framework 4\.8 format\)/);
    assert.match(reason, /the packages\.config of 3 projects pin exact package versions/);
    assert.deepEqual(discoverContract(profile, dir, rubric, []), []);
  });

  test("next to projects that build on Linux, a Windows-only project is its own component, and the commands, lock check and faults leave it out", () => {
    const dir = join(FIXTURES, "dotnet-ios-monorepo", "repo");
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(profile.components.filter((c) => c.path.startsWith("backend")).map((c) => [c.id, c.path, c.stack, c.assessed]), [
      ["backend", "backend", "dotnet", true],
      ["Billing.Admin", "backend/src/Billing.Admin", "dotnet-windows", false],
    ]);
    assert.deepEqual(discoverContract(profile, dir, rubric, []).filter((c) => c.component === "backend").map((c) => [c.kind, c.command]), [
      ["doctor", "dotnet --version"],
      ["install", "dotnet restore tests/Billing.Tests/Billing.Tests.csproj --locked-mode"],
      ["build", "dotnet build tests/Billing.Tests/Billing.Tests.csproj --no-restore"],
      ["test", "dotnet test tests/Billing.Tests/Billing.Tests.csproj --no-restore"],
    ]);
    assert.deepEqual(imagePlan(profile, dir).slice(1), [{ image: "mcr.microsoft.com/dotnet/sdk:8.0", components: ["backend"] }], "net8.0-windows doesn't pick the image");
    assert.deepEqual(targetFiles(dir, profile.components[0]), ["backend/src/Billing/Invoice.cs"]);

    const mixed = repo({
      "App.sln": "",
      "src/Core/Core.csproj": proj("net8.0"),
      "src/Core/Form.cs": "namespace Core; public static class Form { public static int A(int x) { if (x > 0) { return 1; } return 0; } }",
      "src/Desk/Desk.csproj": proj("net8.0-windows", '<PackageReference Include="Serilog" Version="4.0.0" /><ProjectReference Include="..\\Core\\Core.csproj" />'),
      "src/Desk/Form.cs": "namespace Desk; public static class Form { public static int B(int x) { if (x > 0) { return 1; } return 0; } }",
      "src/Tool/Tool.csproj": proj("net8.0", '<ProjectReference Include="..\\Core\\Core.csproj" />'),
      "tests/Core.Tests/Core.Tests.csproj": proj("net8.0", XUNIT + '<ProjectReference Include="../../src/Core/Core.csproj" />'),
      "tests/Core.Tests/packages.lock.json": "{}",
      "tests/Core.Tests/FormTests.cs": "public class FormTests { }",
    });
    assert.equal(ecosystemOf("nuget")!.install(mixed, ".", { ignoreScripts: false }).command, "dotnet restore src/Tool/Tool.csproj --locked-mode && dotnet restore tests/Core.Tests/Core.Tests.csproj --locked-mode", "Desk's unlocked Serilog doesn't unfreeze the restore");
    const cmds = hooks.commands(mixed, { path: "." } as never);
    assert.deepEqual(cmds.map((c) => c.command), ["dotnet build src/Tool/Tool.csproj --no-restore && dotnet build tests/Core.Tests/Core.Tests.csproj --no-restore", "dotnet test tests/Core.Tests/Core.Tests.csproj --no-restore"]);
    assert.match(cmds[0].reason, /Desk\.csproj needs Windows and is listed apart/);
    assert.deepEqual(hooks.mutation.covered(mixed, { path: "." } as never, ["tests/Core.Tests/FormTests.cs"], ["src/Core/Form.cs", "src/Desk/Form.cs"]), ["src/Core/Form.cs"], "no fault goes into code the build leaves out");
  });
});
