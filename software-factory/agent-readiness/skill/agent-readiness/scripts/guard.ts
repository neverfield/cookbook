// The beforeShellExecution hook `readiness guard install` adds to .cursor/hooks.json. It reads the
// hook's JSON from stdin and prints the decision (lib/guard.ts).
import { guardDecision } from "./lib/guard.ts";
import type { GuardInput } from "./lib/guard.ts";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input: GuardInput;
  try {
    input = JSON.parse(raw) as GuardInput;
  } catch {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
    return;
  }
  process.stdout.write(JSON.stringify(guardDecision(input)));
});
