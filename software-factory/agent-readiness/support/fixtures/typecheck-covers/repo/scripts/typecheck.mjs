// A small stand-in for tsc, so the fixture installs nothing from a registry. It checks the .ts files
// in the folders it is given and reports a literal assigned to a variable annotated with a different
// primitive type, such as `const n: number = "x";`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*:\s*(number|string|boolean)\s*=\s*(.+?);?\s*$/;

function literalType(value) {
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (/^(["'`]).*\1$/.test(value)) return "string";
  if (value === "true" || value === "false") return "boolean";
  return null;
}

let errors = 0;
for (const dir of process.argv.slice(2)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    readFileSync(join(dir, file), "utf8").split(/\r?\n/).forEach((line, i) => {
      const m = line.match(DECL);
      const actual = m && literalType(m[3].trim());
      if (m && actual && actual !== m[2]) {
        console.error(`${join(dir, file)}(${i + 1}): error: Type '${actual}' is not assignable to type '${m[2]}'.`);
        errors++;
      }
    });
  }
}
console.log(`${errors} type ${errors === 1 ? "error" : "errors"}`);
process.exit(errors ? 1 : 0);
