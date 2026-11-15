import { execFile, spawnSync } from "node:child_process";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function gh(args: string[], cwd?: string): GhResult {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function ghJson<T>(args: string[], cwd?: string): T {
  const r = gh(args, cwd);
  if (!r.ok) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as T;
}

// String variables go as -f and numbers as -F, so a value is never parsed as a file path or JSON.
export function ghGraphql<T>(query: string, vars: Record<string, string | number | null>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v !== null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const out = ghJson<{ data?: T; errors?: { message: string }[] }>(args);
  if (out.errors?.length || !out.data) throw new Error(`gh api graphql failed: ${(out.errors ?? []).map((e) => e.message).join("; ") || "no data"}`);
  return out.data;
}

// Every page of a REST list, one jq result per line.
export function ghPagedLines(path: string, jq: string): Promise<string[]> {
  return new Promise((done, reject) => {
    execFile("gh", ["api", "--paginate", path, "--jq", jq], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh api ${path} failed: ${String(stderr).trim() || err.message}`));
      else done(stdout.split("\n").filter((l) => l.trim()));
    });
  });
}

export function ghAvailable(): boolean {
  return gh(["auth", "status"]).ok;
}
