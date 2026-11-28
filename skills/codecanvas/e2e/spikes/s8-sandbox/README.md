# Spike S8: Headless Claude CLI Runner & OS Sandbox Harness

Self-contained verification harness for `ARCHITECTURE-V2` §10.2 (`⚑S8`), §15, and §18.
Requires only Node.js (v20+) and standard OS tooling (Linux Landlock via `python3`, `unshare`, or `bwrap`; macOS `sandbox-exec`). Zero external npm dependencies.

## Running

```bash
node run.mjs
```

Emit machine-readable JSON report:

```bash
node run.mjs --json
```

## What It Tests

1. **Environment & Sandbox Probe (`lib/probe.mjs`)**: detects `claude` CLI, `bwrap`, Linux Landlock ABI (`lib/landlock-exec.py`), `unshare -Urm`, and macOS `sandbox-exec`.
2. **Adversarial OS Sandbox Escape Matrix (`lib/sandbox-linux.mjs`, `lib/sandbox-macos.mjs`)**: tests every available OS sandbox backend against all four attack vectors on a real `git clone --shared` setup:
   - **Vector 1 (Direct Bash write)**: `/tmp/outside`, `../parent-repo/`, symlink-to-parent traversal, cross-boundary `mv`/hardlink, and `truncate -s 0`.
   - **Vector 2 (Node script write)**: `fs.writeFileSync` to parent repo and `/tmp`, plus `fs.appendFileSync` on parent sentinel.
   - **Vector 3 (Package `postinstall`)**: offline `npm install` of `fixtures/evil-pkg` whose `postinstall.js` attempts to create and modify files in the parent repo.
   - **Vector 4 (`git` escape)**: `GIT_DIR` targeting parent `.git/config`, `git -C` commit into parent, `core.hooksPath` + planting a hook into parent `.git/hooks`, `git worktree add` outside clone, and direct write to shared alternates `.git/objects`.
3. **Legitimate In-Clone Work**: verifies `--shared` git history reads, file creation/modification/deletion, and in-clone `git commit` succeed while leaving the parent repo byte-for-byte untouched.
4. **`PreToolUse` Hook (`lib/pretooluse-hook.mjs`)**: verifies real stdin/stdout Claude Code hook JSON decisions (including ancestor-walking `realpathSync` symlink checks, `.git/` protection, git-escape Bash guards, and fail-closed missing env behavior).
5. **macOS Seatbelt Profile (`lib/sandbox-macos.mjs`)**: verifies SBPL profile generation, narrow `file-write*` allowlists, secret read denials, and path-injection rejection (with live execution on `darwin`).
6. **End-to-End Headless Runner (`lib/runner.mjs`, `lib/mock-claude.mjs`)**: verifies `--output-format stream-json --verbose --settings <ephemeral>` NDJSON streaming, hook denials, OS sandbox denials, legitimate edits/commits, process-group cleanup, and fail-closed refusal (`SandboxUnavailableError`) when no OS sandbox is available.
