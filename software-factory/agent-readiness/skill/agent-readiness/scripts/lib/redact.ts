export interface SecretHit {
  type: string;
  line: number;
  // A key vendors publish in their docs as an example, such as AWS's documented access key. It is
  // still redacted from output; whether it blocks is the static check's decision.
  example?: boolean;
}

const PATTERNS: { type: string; re: RegExp }[] = [
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { type: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { type: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: "Cursor API key", re: /\bcrsr_[A-Za-z0-9]{20,}\b/g },
  { type: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

// Keys published in vendor documentation as examples. They match a real key's shape and grant nothing.
// Assembled, so this file doesn't itself read as holding a key when a repo commits the skill.
export const EXAMPLE_KEYS = new Set([
  ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  ["AKIA", "I44QH8DHBEXAMPLE"].join(""),
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
]);

const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']([^"'\s]{12,})["']/gi;
// A .env line or shell export with an unquoted value: `API_KEY=abc...`, `export DB_PASSWORD=...`.
const ENV_ASSIGNMENT = /^(\s*(?:export\s+)?(?=[A-Z])[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)([^\s"'#$`{][^\s"'#]{11,})/gm;
// The password in a URL, as connection strings and proxy settings carry it: scheme://user:password@host.
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)([^\s@/"'`]+)(@[^\s/"'`]+)/gi;
const PLACEHOLDER = /example|xxx|changeme|placeholder|dummy|fake|test|<|\$\{|your[-_]/i;
// Values in a URL's password slot that stand for a password rather than being one.
const URL_PLACEHOLDER = /^(password|pass|passwd|secret|pwd|\*+|\$\w+|\$\{[^}]*\}|<[^>]*>|%[A-Z_]+%|x+)$/i;

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
      const m = line.match(p.re);
      if (m) {
        hits.push({ type: p.type, line: i + 1, ...(m.every((v) => EXAMPLE_KEYS.has(v)) ? { example: true } : {}) });
        specific = true;
      }
    }
    if (specific) return;
    ASSIGNMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT.exec(line))) {
      if (EXAMPLE_KEYS.has(m[2])) hits.push({ type: "Secret assignment", line: i + 1, example: true });
      else if (!PLACEHOLDER.test(m[2])) hits.push({ type: "Secret assignment", line: i + 1 });
    }
    if (hits.some((h) => h.line === i + 1)) return;
    ENV_ASSIGNMENT.lastIndex = 0;
    const env = ENV_ASSIGNMENT.exec(line);
    if (env) {
      if (EXAMPLE_KEYS.has(env[2])) hits.push({ type: "Secret assignment", line: i + 1, example: true });
      else if (!PLACEHOLDER.test(env[2])) hits.push({ type: "Secret assignment", line: i + 1 });
    }
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
  for (const p of PATTERNS) out = out.replace(p.re, `[redacted:${p.type}]`);
  out = out.replace(ASSIGNMENT, (whole, key: string, value: string) =>
    PLACEHOLDER.test(value) ? whole : whole.replace(value, "[redacted:secret]"),
  );
  out = out.replace(ENV_ASSIGNMENT, (whole, head: string, value: string) => (PLACEHOLDER.test(value) ? whole : `${head}[redacted:secret]`));
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
