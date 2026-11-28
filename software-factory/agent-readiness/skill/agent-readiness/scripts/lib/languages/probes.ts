import type { Component, ContractCommand } from "../types.ts";

// The component's type-check command, or the repo's, as a fault's compile probe. A test script that
// runs tsc next to the tests can't tell it, because which of them reports first depends on how fast
// the machine is.
export function typecheckProbe(comp: Component, contract: ContractCommand[]): { command: string; cwd: string } | null {
  const typecheck = contract.find((c) => c.kind === "typecheck" && (c.component === comp.id || c.component === "*"));
  return typecheck ? { command: typecheck.command, cwd: typecheck.cwd } : null;
}
