export interface SecretHit {
  type: string;
  line: number;
  // A key vendors publish in their docs as an example, such as AWS's documented access key. It is
  // still redacted from output; whether it blocks is the static check's decision.
  example?: boolean;
}

const PATTERNS: { type: string; re: RegExp; keyShaped?: (match: string) => boolean }[] = [
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { type: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { type: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: "Cursor API key", re: /\bcrsr_[A-Za-z0-9]{20,}\b/g },
  // Not inside a hyphenated name: `k3-am68-sk-base-board-csi2-dual-imx219-dtbs` is a Linux device-tree target.
  { type: "OpenAI API key", re: /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g, keyShaped: randomLooking },
  { type: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

// Generated keys mix upper case, lower case and digits; a name made of hyphenated words doesn't.
function randomLooking(match: string): boolean {
  const body = match.replace(/^sk-(?:proj-|svcacct-|admin-)?/, "");
  return /[A-Z]/.test(body) && /[a-z]/.test(body) && /\d/.test(body);
}

// Keys published in vendor documentation as examples. They match a real key's shape and grant nothing.
// Assembled, so this file doesn't itself read as holding a key when a repo commits the skill.
export const EXAMPLE_KEYS = new Set([
  ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  ["AKIA", "I44QH8DHBEXAMPLE"].join(""),
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
]);

const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']([^"'\s]{12,})["']/gi;
// A .env line, shell export or Compose environment entry: `API_KEY=abc...`, `export DB_PASSWORD=...`,
// `JWT_SECRET="..."`, `- SECRET_KEY=...`, `JWT_SECRET: "..."`. None puts spaces around `=`; code and
// Terraform (`X_API_KEY = local.arn`) do. A leading `#` covers a commented line and the TAP output of
// `node --test`, which prints a test's stdout that way. Groups: head, name, quote, value.
const ENV_VALUE = String.raw`(?:(["'])([^"'\s]{12,})\3|()([^\s"'#$\x60{][^\s"'#]{11,}))`;
const ENV_ASSIGNMENT = new RegExp(String.raw`^([^\S\n]*(?:#[^\S\n]*)?(?:-[^\S\n]+)?(?:export[^\S\n]+)?([A-Z][A-Z0-9_]*)(?:=|:[^\S\n]+(?=["'])))` + ENV_VALUE, "gm");
// Output is redacted wherever the assignment starts a word, as in `env API_KEY=... node app.js` or
// `app_1  | API_KEY=...`, not only at the start of a line.
const ENV_IN_OUTPUT = new RegExp(String.raw`((?:^|(?<=[\s#|>]))(?:export\s+)?([A-Z][A-Z0-9_]*)(?:=|:[^\S\n]+(?=["'])))` + ENV_VALUE, "gm");
const SECRET_NAME = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)/;
// Names that point at a secret rather than hold one: CURSOR_API_KEY_SECRET_NAME, DB_PASSWORD_FILE.
const REFERENCE_NAME = /_(NAME|ARN|ID|PATH|FILE|URL|URI|REF|VERSION|REGION)$/;
// Placeholder text in examples and docs: replace-with-your-key, YOURSECRETKEYGOESHERE.
const ENV_PLACEHOLDER = /replace|your|goes_?here|here$|todo|sample|redacted|<|\.\.\./i;
// What redact() writes in place of a secret. Scanning redacted text must not find it again.
const REDACTED = /\[redacted:[^\]]*\]/;

// A value that describes itself instead of being random: lower-case words that say what it is
// (`astronomy_password`, `something-with-a-#-hash`), or the last words of its own name.
function namesItself(name: string, value: string): boolean {
  const v = value.toLowerCase();
  if (/^[a-z]+(?:[-_.#]+[a-z]+)+$/.test(value) && /(^|[-_.#])(password|passwd|pass|secret|token|key|hash)([-_.#]|$)/.test(v)) return true;
  return name.toLowerCase().replace(/-/g, "_").endsWith(v.replace(/-/g, "_"));
}

function placeholderValue(name: string, value: string): boolean {
  return PLACEHOLDER.test(value) || REDACTED.test(value) || namesItself(name, value);
}

function envSecret(name: string, value: string): boolean {
  return SECRET_NAME.test(name) && !REFERENCE_NAME.test(name) && !placeholderValue(name, value) && !ENV_PLACEHOLDER.test(value);
}
// The password in a URL, as connection strings and proxy settings carry it: scheme://user:password@host,
// and scheme://:password@host, as Redis URLs carry it with no user.
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]*:)([^\s@/"'`]+)(@[^\s/"'`]+)/gi;
// A Symfony parameter reference (`%env(APP_SECRET)%`, `%kernel.secret%`) names where the value comes
// from; a committed literal such as `APP_SECRET=not-a-secret--read-the-doc!` is still flagged. So do
// a shell or template variable (`$DB_PASS`, `${...}`) and an Ant or Maven filter token (`$next-version$`, `@version@`).
const PLACEHOLDER = /example|xxx|changeme|placeholder|dummy|fake|test|<|\$\{|your[-_]|^%(env\([\w:.-]+\)|[\w.-]+)%$|^\$[\w.-]+\$?$|^@[\w.-]+@$/i;
// Values in a URL's password slot that stand for a password rather than being one.
const URL_PLACEHOLDER = /^(password|pass|passwd|secret|pwd|\*+|\$\w+|\$\{[^}]*\}|<[^>]*>|%[A-Z_]+%|x+|\[redacted:[^\]]*\])$/i;

// Local development URLs (postgres://postgres:postgres@db:5432, user:pass@localhost) are committed on
// purpose; a password for a host on a real domain is the leak.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[^.]+|.+\.(local|localhost|internal|test|example|invalid)|(.+\.)?example\.(com|org|net))$/i;

function realCredential(head: string, password: string, rest: string): boolean {
  const user = head.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/:$/, "");
  const host = rest.slice(1).replace(/:\d+$/, "");
  return password.length >= 8 && password !== user && !URL_PLACEHOLDER.test(password) && !PLACEHOLDER.test(password) && !LOCAL_HOST.test(host);
}

export function scanText(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    let specific = false;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      const m = (line.match(p.re) ?? []).filter((v) => !p.keyShaped || p.keyShaped(v));
      if (m.length) {
        hits.push({ type: p.type, line: i + 1, ...(m.every((v) => EXAMPLE_KEYS.has(v)) ? { example: true } : {}) });
        specific = true;
      }
    }
    if (specific) return;
    ASSIGNMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT.exec(line))) {
      if (EXAMPLE_KEYS.has(m[2])) hits.push({ type: "Secret assignment", line: i + 1, example: true });
      else if (!placeholderValue(m[1], m[2])) hits.push({ type: "Secret assignment", line: i + 1 });
    }
    if (hits.some((h) => h.line === i + 1)) return;
    ENV_ASSIGNMENT.lastIndex = 0;
    const env = ENV_ASSIGNMENT.exec(line);
    const value = env ? (env[4] ?? env[6]) : "";
    if (env && EXAMPLE_KEYS.has(value)) hits.push({ type: "Secret assignment", line: i + 1, example: true });
    else if (env && envSecret(env[2], value)) hits.push({ type: "Secret assignment", line: i + 1 });
    URL_CREDENTIAL.lastIndex = 0;
    while ((m = URL_CREDENTIAL.exec(line))) {
      if (realCredential(m[1], m[2], m[3])) {
        hits.push({ type: "Connection string with a password", line: i + 1 });
        break;
      }
    }
  });
  return hits;
}

export function redact(text: string, extraValues: string[] = []): string {
  let out = text;
  for (const value of extraValues) {
    if (value && value.length >= 4) out = out.split(value).join("[redacted:env]");
  }
  for (const p of PATTERNS) out = out.replace(p.re, (whole) => (!p.keyShaped || p.keyShaped(whole) ? `[redacted:${p.type}]` : whole));
  out = out.replace(ASSIGNMENT, (whole, key: string, value: string) => (placeholderValue(key, value) ? whole : whole.replace(value, "[redacted:secret]")));
  out = out.replace(ENV_IN_OUTPUT, (whole, head: string, name: string, quote: string | undefined, quoted: string | undefined, _bare: string, bare: string | undefined) => {
    const value = quoted ?? bare ?? "";
    return envSecret(name, value) ? `${head}${quote ?? ""}[redacted:secret]${quote ?? ""}` : whole;
  });
  out = out.replace(URL_CREDENTIAL, (whole, head: string, password: string, rest: string) => (URL_PLACEHOLDER.test(password) ? whole : `${head}[redacted:password]${rest}`));
  return out;
}

// The passwords inside proxy settings, so output that echoes one is redacted even when the proxy
// URL is printed in a shape the URL pattern doesn't catch.
export function proxyPasswords(env: Record<string, string | undefined>, names: string[]): string[] {
  return names.flatMap((k) => {
    const v = env[k];
    if (!v) return [];
    try {
      const u = new URL(v);
      return u.password ? [decodeURIComponent(u.password), u.password] : [];
    } catch {
      return [];
    }
  });
}

export function tail(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : "…" + text.slice(text.length - maxChars);
}
