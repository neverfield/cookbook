import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { removalAdvice, scanText, secretFindings } from "../skill/agent-readiness/scripts/lib/secrets.ts";
import { notShipped } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { SecretClass } from "../skill/agent-readiness/scripts/lib/types.ts";
import { FIXTURES, commitAll, materialize, readiness } from "../support/tools/fixture.ts";

const rubric = loadRubric("2026-12-beta");
const BLOCKING = rubric.safety!.blockingSecretClasses!;

interface Case {
  file: string;
  lines: (string | string[])[];
  expect: { line: number; class: SecretClass; blocking: boolean }[];
}

const corpus = (JSON.parse(readFileSync(join(FIXTURES, "secrets-corpus", "corpus.json"), "utf8")) as { cases: Case[] }).cases;
const textOf = (c: Case) => c.lines.map((l) => (Array.isArray(l) ? l.join("") : l)).join("\n");

describe("secret classes on the labelled corpus", () => {
  const found = corpus.flatMap((c) => secretFindings(c.file, textOf(c), notShipped(c.file, textOf(c)), BLOCKING).map((f) => ({ c, f })));

  test("precision on blocking findings is 1.0: every blocking finding is labelled blocking", () => {
    const wrong = found.filter(({ c, f }) => f.blocking && !c.expect.some((e) => e.line === f.line && e.blocking)).map(({ f }) => `${f.file}:${f.line} ${f.class}`);
    assert.deepEqual(wrong, []);
  });

  test("recall on labelled blocking lines is 1.0", () => {
    const missed = corpus.flatMap((c) => c.expect.filter((e) => e.blocking && !found.some(({ f }) => f.file === c.file && f.line === e.line && f.blocking)).map((e) => `${c.file}:${e.line}`));
    assert.deepEqual(missed, []);
  });

  test("every finding is on a labelled line, with the labelled class and blocking decision", () => {
    const got = found.map(({ f }) => `${f.file}:${f.line} ${f.class} ${f.blocking ? "blocks" : "listed"}`).sort();
    const want = corpus.flatMap((c) => c.expect.map((e) => `${c.file}:${e.line} ${e.class} ${e.blocking ? "blocks" : "listed"}`)).sort();
    assert.deepEqual(got, want);
  });

  test("template URLs are placeholders in every style, not credentials", () => {
    for (const url of ["f'ftp://{self.username}:{self.password}@{self.host}/'", "'ftp://%(user)s:%(password)s@%(host)s/'", "'sftp://{0}:{1}@{2}/'", "'sftp://{user}:{password}@files.acme-corp.io/'", "\"redis://:{{redis_password}}@cache.acme-corp.io:6379\"", "\"redis://:${REDIS_PASS}@cache.acme-corp.io:6379\""]) {
      assert.deepEqual(scanText(url), [], url);
    }
  });

  test("a generic assignment is listed with its name and length, never its value", () => {
    const value = ["b3f1c9a7d2e84f6a", "9c0d1e2f3a4b5c6d"].join("");
    const [f] = secretFindings("src/movies.py", `API_KEY = '${value}'`, null, BLOCKING);
    assert.equal(f.class, "generic_assignment");
    assert.equal(f.blocking, false);
    assert.equal(f.rule, "secret-generic");
    assert.match(f.masked, /^API_KEY = "…" \(32 characters\)$/);
    assert.ok(!f.detail.includes(value) && !f.masked.includes(value));
  });

  test("rubrics before 2026-12-beta name no classes, and every class still blocks", () => {
    const value = ["b3f1c9a7d2e84f6a", "9c0d1e2f3a4b5c6d"].join("");
    assert.equal(loadRubric("2026-11-beta").safety, undefined);
    assert.equal(secretFindings("src/movies.py", `API_KEY = '${value}'`, null, undefined)[0].blocking, true);
  });
});

describe("advice conditioned on class and file", () => {
  test("a tracked source file is never told to leave version control", () => {
    const text = removalAdvice(["src/settings.py", "config/app.yml"]);
    assert.doesNotMatch(text, /gitignore|git rm|stop tracking/i);
    assert.match(text, /the file stays in the repository/);
  });

  test("a dotenv file is told to stop being tracked, with an example in its place", () => {
    assert.match(removalAdvice(["config/dev.env"]), /Stop tracking config\/dev\.env with `git rm --cached`/);
    assert.match(removalAdvice([".env.production"]), /Stop tracking \.env\.production/);
  });

  test("the 2026-12-beta secret template never mentions .gitignore", () => {
    assert.doesNotMatch(JSON.stringify(rubric.templates["safety:secret"]), /gitignore/i);
  });

  function auditReports(repo: string): string {
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"], { SA_READINESS_EVAL_SEED: "fixture-seed" });
    assert.equal(r.code, 0, r.out.slice(-2000));
    return ["report.json", "report.md", "report.html"].map((f) => readFileSync(join(repo, ".agent-readiness", "latest", f), "utf8")).join("\n");
  }

  test("a blocking provider token in source: the report says rotate, and never .gitignore", () => {
    const text = auditReports(materialize("python-public-client-keys"));
    assert.match(text, /rotate/i);
    assert.doesNotMatch(text, /gitignore/i);
    assert.match(text, /src\/mediabot\/settings\.py, read the value from an environment variable/);
  });

  test("placeholder credentials in a commented example and a key in a test file named its own way are listed; a real password in a comment and a key in shipped code still block", () => {
    const repo = materialize("placeholder-secrets");
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
    for (const f of ["src/auth/verifier.servertest.js", "src/auth/signer.js"]) writeFileSync(join(repo, f), readFileSync(join(repo, f), "utf8").replace("__PRIVATE_KEY__", pem));
    commitAll(repo, "add the signing keys");
    auditReports(repo);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness", "latest", "report.json"), "utf8"));
    const audit = JSON.parse(readFileSync(join(repo, report.audit.storedAt, "audit.json"), "utf8"));
    const secrets = (audit.safety as { kind: string; file: string; line: number; blocking: boolean; rule: string }[]).filter((s) => s.kind === "secret");
    assert.deepEqual(secrets.filter((s) => s.blocking).map((s) => `${s.file}:${s.line}`).sort(), ["chart/values.yaml:11", "src/auth/signer.js:2"]);
    assert.deepEqual(secrets.filter((s) => !s.blocking).map((s) => `${s.file}:${s.line} ${s.rule}`), ["src/auth/verifier.servertest.js:6 secret-not-shipped"]);
  });

  test("only generic assignments: no rotate and no .gitignore advice anywhere, and safety states its coverage", () => {
    const repo = materialize("python-public-client-keys");
    const settings = join(repo, "src/mediabot/settings.py");
    writeFileSync(settings, readFileSync(settings, "utf8").replace(/^AWS_ACCESS_KEY_ID = .*$/m, "AWS_ACCESS_KEY_ID = os.environ.get('AWS_ACCESS_KEY_ID')"));
    commitAll(repo, "read the key from the environment");
    const text = auditReports(repo);
    assert.doesNotMatch(text, /rotat/i);
    assert.doesNotMatch(text, /gitignore/i);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness", "latest", "report.json"), "utf8"));
    const audit = JSON.parse(readFileSync(join(repo, report.audit.storedAt, "audit.json"), "utf8"));
    assert.deepEqual(audit.safety.filter((s: { blocking: boolean }) => s.blocking), []);
    assert.ok(audit.safety.some((s: { rule: string; file: string }) => s.rule === "secret-generic" && s.file === "src/mediabot/clients/movies.py"));
    assert.match(text, /no blocking safety findings from \d+ secret patterns over \d+ files; \d+ items? listed for review/);
  });
});
