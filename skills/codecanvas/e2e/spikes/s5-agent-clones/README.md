# Spike S5: Agent Clone Setup and Startup Latency Benchmark

Self-contained benchmark harness validating `ARCHITECTURE-V2` §8.3, §10.2, §17, and §18 (`⚑S5`).

## What It Benchmarks

Generates a representative multi-page Next.js 16 (Turbopack) + React 19 + Tailwind CSS v4 + pnpm workspace monorepo fixture (`apps/web`, `packages/ui`, `packages/shared`, realistic dependency graph, 20-commit git history, and root/app `.env*` files) inside an isolated temporary directory, then runs five experiments:

- **Experiment A — Clone Creation & Disk Footprint:** `git clone --shared` (external and nested under `.codecanvas/cache/clones/`) vs `git worktree add --detach` vs `git clone --no-hardlinks`, plus `git apply` active change set patch and `.git` independence verification.
- **Experiment B — Dependency Install Strategies (Warm Store):** `pnpm install --frozen-lockfile --prefer-offline`, `pnpm install --frozen-lockfile --offline`, `pnpm install --frozen-lockfile --offline --ignore-scripts`, raw `cp -al` hardlink copy (inode-sharing isolation audit + reflink probe), and symlinked `node_modules` (demonstrating workspace resolution escape).
- **Experiment C — Safe `.env*` Copying:** Allowlisted `.env*` copying with `0600` mode enforcement, template skipping (`.env.example`), symlink-escape rejection, path-traversal rejection, and clean `git status` verification.
- **Experiment D — Next.js Turbopack Root Resolution:**
  - `D1a`: Nested clone inside `<parent>/.codecanvas/cache/clones/` *without* explicit `turbopack.root`.
  - `D1b`: Nested clone inside `<parent>/.codecanvas/cache/clones/` *with* explicit `turbopack.root = cloneRoot` and private `distDir = '.codecanvas/cache/next'`, plus live workspace HMR & parent cross-contamination checks.
  - `D2`: External clone under simulated `~/.codecanvas/agents/<repoId>/<task>/` without and with explicit `turbopack.root`.
  - `D3`: Concurrent parent dev server + clone agent-host dev server on separate dynamic ports.
- **Experiment E — End-to-End Agent-Host Startup Latency:** Full pipeline (`git clone --shared` → `git apply` → `pnpm install` → safe `.env*` copy → `next dev --turbopack` Ready → first SSR HTTP 200 on `/`, plus secondary routes and warm restart) on native vCPUs and 4-vCPU-pinned (`taskset -c 0-3`, matching §17).

## Running

Requires Node 22+, `pnpm`, `git`, and Linux `taskset` (for 4-vCPU pinning). No `npm install` is needed in this directory.

```bash
node skills/codecanvas/e2e/spikes/s5-agent-clones/run.mjs
```

Options:

- `--trials <n>` — Trials per repeated experiment (default: `3`)
- `--four-vcpu-trials <n>` — 4-vCPU pinned E2E trials (default: `2`)
- `--out <path>` — Write full JSON results to `<path>`
- `--json` — Emit JSON only on stdout
- `--keep-tmp` — Keep the temporary fixture workspace for manual inspection

## Safety & Cleanup

- Allocates dynamic loopback ports in `4720–4899` (explicitly forbids `4400–4410` and `4600`).
- Spawns every subprocess in its own process group (`detached: true`) and tears down via `-pid` (`SIGTERM` → `SIGKILL`), never broad `pkill -f`.
- Removes all temporary fixtures, clones, and simulated home directories on exit (including `SIGINT`/`SIGTERM`).
