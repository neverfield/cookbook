import type { SecretClass } from "./types.ts";
import { ASSIGNMENT, ENV_ASSIGNMENT, EXAMPLE_KEYS, LOCAL_HOST, PATTERNS, PLACEHOLDER, URL_CREDENTIAL, URL_PLACEHOLDER, describesItself, envSecret, placeholderValue } from "./redact.ts";

// Findings become advice, so they are precision-biased: redact.ts hides anything that might be a
// secret, and this file decides which of those are worth a reader's action.
//
// provider_token: a value in a vendor's own token shape (AWS, GitHub, Stripe, ...).
// private_key: a PEM private key header.
// url_credential: a literal password in a URL for a host on a real domain.
// generic_assignment: a long value assigned to a name that sounds secret. Public client keys the app
// ships on purpose, test values and placeholders all look like this, so on its own it proves nothing.
export const SECRET_CLASSES: readonly SecretClass[] = ["provider_token", "private_key", "url_credential", "generic_assignment"];

export interface SecretHit {
  type: string;
  class: SecretClass;
  line: number;
  // A key vendors publish in their docs as an example, such as AWS's documented access key. It is
  // still redacted from output; whether it blocks is the static check's decision.
  example?: boolean;
  // For a generic assignment: the name the value is assigned to, and the value's length. The value
  // itself is never kept.
  name?: string;
  length?: number;
}

// How many patterns the scan tries, for the safety condition's statement of what it covered.
export const SECRET_PATTERN_COUNT = PATTERNS.length + 3;

// A template slot standing in for a URL's user, password or host: `{user}`, `{0}`, `{{ password }}`,
// `%(password)s`, `${PASS}`, `$PASS`, `<password>`. A password that names itself, as in a commented
// example's `proxy_user:proxy_password@`, is a placeholder too.
const TEMPLATE_SLOT = /\{[^{}]*\}|%\([\w.]+\)[sdr]|\$\{[^}]*\}|^\$\w+$|<[^>]*>/;

function urlCredential(head: string, password: string, rest: string): boolean {
  const user = head.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/:$/, "");
  const host = rest.slice(1).replace(/:\d+$/, "");
  if ([user, password, host].some((s) => TEMPLATE_SLOT.test(s))) return false;
  return password.length >= 8 && password !== user && !URL_PLACEHOLDER.test(password) && !PLACEHOLDER.test(password) && !describesItself(password) && !LOCAL_HOST.test(host);
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
        hits.push({ type: p.type, class: p.type === "Private key" ? "private_key" : "provider_token", line: i + 1, ...(m.every((v) => EXAMPLE_KEYS.has(v)) ? { example: true } : {}) });
        specific = true;
      }
    }
    if (specific) return;
    const generic = (name: string, value: string, example: boolean) => hits.push({ type: "Secret assignment", class: "generic_assignment", line: i + 1, name, length: value.length, ...(example ? { example: true } : {}) });
    ASSIGNMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT.exec(line))) {
      if (EXAMPLE_KEYS.has(m[2])) generic(m[1], m[2], true);
      else if (!placeholderValue(m[1], m[2])) generic(m[1], m[2], false);
    }
    if (hits.some((h) => h.line === i + 1)) return;
    ENV_ASSIGNMENT.lastIndex = 0;
    const env = ENV_ASSIGNMENT.exec(line);
    const value = env ? (env[4] ?? env[6]) : "";
    if (env && EXAMPLE_KEYS.has(value)) generic(env[2], value, true);
    else if (env && envSecret(env[2], value)) generic(env[2], value, false);
    URL_CREDENTIAL.lastIndex = 0;
    while ((m = URL_CREDENTIAL.exec(line))) {
      if (urlCredential(m[1], m[2], m[3])) {
        hits.push({ type: "Connection string with a password", class: "url_credential", line: i + 1 });
        break;
      }
    }
  });
  return hits;
}

// Values vendors publish in their docs as examples; they appear in many repos and grant nothing.
// Built from parts so this file never holds a value the secret scan matches.
const DOCUMENTED_EXAMPLES = new RegExp(["AKIA" + "IOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY"].join("|"));

// A PEM header counts as a key only with a base64 body after it, before its END line.
function pemHasKey(lines: string[], index: number): boolean {
  const after = lines[index].split(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)[1] ?? "";
  const body = [after, ...lines.slice(index + 1, index + 4)].join("\n").split(/-----END/)[0];
  return /[A-Za-z0-9+/]{40,}/.test(body.replace(/\\n/g, "\n"));
}

export interface SecretFinding {
  class: SecretClass;
  type: string;
  file: string;
  line: number;
  // What the report may show of the value: the name it is assigned to and its length, or nothing.
  masked: string;
  // Every file the scan reads comes from a one-commit clone of the audited commit, so it is tracked.
  tracked: true;
  // Null when shipped; otherwise the kind of file that isn't (test, generated, docs or example).
  notShipped: string | null;
  blocking: boolean;
  rule: "secret" | "secret-not-shipped" | "secret-example" | "secret-no-key" | "secret-generic";
  detail: string;
}

// `blockingClasses`: the classes that block when found in shipped code. Rubrics before 2026-12-beta
// name none, and every class blocks.
export function secretFindings(file: string, text: string, notShipped: string | null, blockingClasses?: readonly SecretClass[]): SecretFinding[] {
  const lines = text.split("\n");
  return scanText(text).map((hit) => {
    const line = lines[hit.line - 1] ?? "";
    const masked = hit.name ? `${hit.name} = "…" (${hit.length} characters)` : "";
    const base = { class: hit.class, type: hit.type, file, line: hit.line, masked, tracked: true as const, notShipped };
    if (notShipped) return { ...base, blocking: false, rule: "secret-not-shipped" as const, detail: `${hit.type} in a ${notShipped} file, listed for review` };
    if (hit.example || DOCUMENTED_EXAMPLES.test(line)) return { ...base, blocking: false, rule: "secret-example" as const, detail: `${hit.type}: a documented example value, listed for review` };
    if (hit.class === "private_key" && !pemHasKey(lines, hit.line - 1)) return { ...base, blocking: false, rule: "secret-no-key" as const, detail: "a private key header with no key after it, listed for review" };
    if (blockingClasses && !blockingClasses.includes(hit.class)) return { ...base, blocking: false, rule: "secret-generic" as const, detail: `${masked}: a value assigned to a name that sounds secret, with no provider's token shape, listed for review` };
    return { ...base, blocking: true, rule: "secret" as const, detail: hit.type };
  });
}

// What a reader is told to do about blocking findings, by where they are. Rotation is advice for
// blocking classes only. Only a dotenv file, which holds nothing but values, is told to leave
// version control; any other tracked file, source or config the app reads, keeps its place and
// loses the value.
const DOTENV = /(^|\/)\.env(\.[\w.-]+)?$|\.env$/i;

export function removalAdvice(files: string[]): string {
  const dotenv = files.filter((f) => DOTENV.test(f));
  const code = files.filter((f) => !DOTENV.test(f));
  const parts: string[] = [];
  if (code.length) parts.push(`In ${code.join(", ")}, read the value from an environment variable or the secret store at run time and delete the literal; the file stays in the repository.`);
  if (dotenv.length) parts.push(`Stop tracking ${dotenv.join(", ")} with \`git rm --cached\`, commit an example with placeholder values in its place, and load the real values from the secret store.`);
  return parts.join(" ");
}
