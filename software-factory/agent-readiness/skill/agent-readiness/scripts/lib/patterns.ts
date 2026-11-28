// Patterns more than one module matches against. This file imports nothing, so any module may use it.

// Variable names that look like they hold a secret, by what each check can afford to miss.
// Redacting inherited variables from output (evidence.ts): recall first, since hiding a value that
// wasn't secret costs nothing.
export const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
// A committed `NAME=value` that is a secret (redact.ts): precision first, since it becomes a finding.
export const SECRET_ASSIGNMENT_NAME = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)/;
// A variable a failing command says is missing that is a credential, not a setting (diagnose.ts).
export const CREDENTIAL_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;

// A command that runs sudo, as a word of its own: `sudo apt-get`, `x && sudo y`, `$(sudo z)`.
export const SUDO = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;

// Whether `index` falls inside a quoted string on one line of JavaScript-like code. Backslash escapes
// count; a quote left open at the end of the line holds to its end.
export function insideString(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
  }
  return quote !== null;
}
