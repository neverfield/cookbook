import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { storeAudit } from "../skill/agent-readiness/scripts/lib/history.ts";
import { redact } from "../skill/agent-readiness/scripts/lib/redact.ts";
import { scanText } from "../skill/agent-readiness/scripts/lib/secrets.ts";
import type { ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { paths } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { makeAudit } from "./helpers.ts";

// Assembled at run time, so this file doesn't itself read as holding secrets.
const v = (...parts: string[]) => parts.join("");
const JWT = v("unquoted_prod_jwt_", "secret_111111");
const PG = v("unquoted_pg_", "pass_222222");
const QUOTED_JWT = v("quoted_prod_jwt_", "secret_333333");
const DJANGO = v("quoted_django_", "secret_444444");
const REDIS = v("emptyuser_redis_", "pass_555555");

const ENV_FILE = [
  `JWT_SECRET=${JWT}`,
  `DATABASE_URL=postgres://admin:${PG}@db.prod.acme.org:5432/app`,
  `QUOTED_JWT_SECRET="${QUOTED_JWT}"`,
  `SECRET_KEY="${DJANGO}"`,
  `REDIS_URL=redis://:${REDIS}@cache.prod.acme.org:6379/0`,
].join("\n");
const VALUES = [JWT, PG, QUOTED_JWT, DJANGO, REDIS];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "readiness-redact-"));
  writeFileSync(join(dir, "a.txt"), "x");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

describe("redaction of what a failing test prints", () => {
  test("redacted text doesn't scan as a secret again", () => {
    const red = redact(ENV_FILE);
    for (const s of VALUES) assert.ok(!red.includes(s), `${s} leaked:\n${red}`);
    assert.deepEqual(scanText(red), [], red);
    assert.deepEqual(scanText("postgres://admin:[redacted:password]@db.prod.acme.org:5432/app"), []);
    assert.deepEqual(scanText(`token = "[redacted:secret]"`), []);
  });

  test("every line of the .env file is still found before redaction", () => {
    assert.deepEqual(scanText(ENV_FILE).map((h) => h.line), [1, 2, 3, 4, 5]);
  });

  test("quoted .env and Compose secrets under a prefixed or suffixed name are caught", () => {
    for (const line of [`JWT_SECRET="${QUOTED_JWT}"`, `SECRET_KEY='${DJANGO}'`, `      JWT_SECRET: "${DJANGO}"`, `  - SECRET_KEY=${DJANGO}`, `# SECRET_KEY="${DJANGO}"`, `x-api-key: "${DJANGO}"`]) {
      assert.equal(scanText(line).length, 1, line);
      assert.ok(!redact(line).includes(DJANGO), line);
    }
    for (const line of [`tokenizer: "bert-base-uncased-v2"`, `secret_name = "prod/payments/stripe"`, `token_endpoint: "https://auth.acme.org/oauth/token"`]) {
      assert.deepEqual(scanText(line), [], line);
      assert.equal(redact(line), line);
    }
  });

  test("a commented or TAP-prefixed .env line is caught and redacted", () => {
    assert.deepEqual(scanText(`# JWT_SECRET=${JWT}`).map((h) => h.line), [1]);
    for (const line of [`# JWT_SECRET=${JWT}`, `    # API_KEY=${JWT}`, `app_1  | JWT_SECRET=${JWT}`, `env JWT_SECRET=${JWT} node app.js`]) {
      assert.ok(!redact(line).includes(JWT), line);
    }
  });

  test("a URL with an empty user name is caught and redacted", () => {
    const url = `redis://:${REDIS}@cache.prod.acme.org:6379/0`;
    assert.deepEqual(scanText(url).map((h) => h.type), ["Connection string with a password"]);
    assert.equal(redact(url), "redis://:[redacted:password]@cache.prod.acme.org:6379/0");
    assert.deepEqual(scanText("redis://:devpassword123@localhost:6379"), []);
  });

  test("the output of a real node --test run is stored with every secret redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-tap-"));
    writeFileSync(join(dir, "env.test.mjs"), `import { test } from "node:test";\ntest("prints its env", () => { console.log(process.env.ENV_FILE); throw new Error("boom"); });\n`);
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "env.test.mjs"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, ENV_FILE } });
    const output = r.stdout + r.stderr;
    assert.match(output, /^# JWT_SECRET=/m, "TAP prints the test's stdout behind `# `");
    const audit = makeAudit({ components: [{ id: "a", share: 1 }] });
    audit.evidence[0].summary = redact(output);
    const p = paths(repo());
    const stored = storeAudit(p, audit, {} as ReportJson, "", "");
    const text = readFileSync(join(stored, "audit.json"), "utf8");
    for (const s of VALUES) assert.ok(!text.includes(s), `${s} reached audit.json`);
  });

  test("an unredacted secret inside a stored output's lines is refused", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1 }] });
    audit.evidence[0].summary = `TAP version 13\n# JWT_SECRET=${JWT}\nnot ok 1`;
    assert.throws(() => storeAudit(paths(repo()), audit, {} as ReportJson, "", ""), /Refusing to write audit .*Secret assignment \(audit\.json\.evidence\[0\]\.summary, line 2\)/);
    const quoted = makeAudit({ components: [{ id: "a", share: 1 }] });
    quoted.evidence[0].summary = `SECRET_KEY="${DJANGO}"`;
    assert.throws(() => storeAudit(paths(repo()), quoted, {} as ReportJson, "", ""), /Refusing to write/);
  });
});

describe("secret-scan false positives from real repos", () => {
  test("google/gson pom.xml:405, an Ant replace token, isn't a secret", () => {
    const line = `<replace token="$next-version$" value="\${project.version}" encoding="\${project.build.sourceEncoding}">`;
    assert.deepEqual(scanText(line), []);
    assert.deepEqual(scanText(`<filter token="@version@" value="1.2.3-SNAPSHOT"/>`), []);
    assert.deepEqual(scanText(`password: "$DB_PASSWORD_FROM_VAULT"`), []);
  });

  test("torvalds/linux arch/arm64/boot/dts/ti/Makefile:373, a device-tree target, isn't an OpenAI key", () => {
    const line = "k3-am68-sk-base-board-csi2-dual-imx219-dtbs := k3-am68-sk-base-board.dtb \\";
    assert.deepEqual(scanText(line), []);
    assert.equal(redact(line), line);
    const key = v("sk-", "proj-", "Q7xT2mN9pL4vR8kW3zY6bC1dF5gH0jA2sE7uI9oP3qZ");
    assert.deepEqual(scanText(`OPENAI_API_KEY=${key}`).map((h) => h.type), ["OpenAI API key"]);
    assert.ok(!redact(`key ${key}`).includes(key));
  });

  test("open-telemetry/opentelemetry-demo .env:167-168, passwords that name themselves, aren't secrets", () => {
    const lines = ["POSTGRES_ASTRONOMY_PASSWORD=astronomy_password    # defined in src/postgresql/init.sql", "POSTGRES_MONITORING_PASSWORD=monitoring_password  # defined in src/postgresql/init.sql"];
    assert.deepEqual(scanText(lines.join("\n")), []);
    assert.deepEqual(scanText(`SECRET_HASH="something-with-a-#-hash"`), [], "motdotla/dotenv README.md:148");
    assert.deepEqual(scanText(`MONITORING_PASSWORD=monitoring_password_7Kq2x9`).map((h) => h.line), [1], "a value with random characters is still a secret");
  });
});
