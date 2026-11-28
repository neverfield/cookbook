---
name: codecanvas
description: Zero-footprint visual design canvas for React 17-19 web apps. Inspect real app screens, make tactile text, layout, style, prop, variant, and token edits directly in the project's existing styling system, delegate complex behaviour changes to a sandboxed coding agent in an isolated clone, and ship PRs with before/after verification or discard cleanly.
---

# codecanvas (v2)

`codecanvas` is a zero-footprint visual design canvas for React 17-19 web applications (React Server Components require React 19). Everything codecanvas installs, caches, or builds lives under `.codecanvas/`; deleting `.codecanvas/` uninstalls it with a clean `git status`.

## Product Contract

- **Tactile editing:** Edit text, layout, styles, props, variants, and tokens directly on rendered app screens. Each write lands cleanly in the project's existing styling system (Tailwind, CSS Modules/stylesheets/Sass, inline styles, variants, styled-components, emotion, MUI `styled`).
- **Transparent safety and trust:** Before writing, see where an edit lands, why, and its blast radius. Afterwards, verify computed styles and visible screens. Edits live in a revertible change set until shipped or discarded.
- **Behaviour changes:** Navigation and state transitions via structured intents; open-ended behaviour changes delegated to a sandboxed coding agent in an isolated clone with visual and scripted verification.
- **Ship or discard:** Open a PR with before/after verification or discard everything cleanly.

## Core Invariants (I1-I10)

- **I1 Zero footprint:** No app dependencies, config edits, or source imports; caches and private build outputs live under `.codecanvas/cache/`.
- **I2 Exact or refuse:** Edits target the exact element and revision the user saw via `SourceRef` + `RevMap` chains; external edits refuse and re-select live DOM.
- **I3 Never guess a write target:** Unresolvable or computed origins are explained with supported alternatives, never silently overwritten.
- **I4 Safe writes:** Planned, previewed, contained, validated, atomic, verified, and reversible.
- **I5 Sound freshness:** Stale snapshots are never presented as fresh.
- **I6 Determinism:** Browser and server rendering run under a deterministic contract; unsettled screens are never cached as canonical.
- **I7 Work tracks what is visible:** Pull-based scheduling and bounded verification; full passes only on explicit batch actions.
- **I8 Local and authenticated:** Loopback binds (`127.0.0.1` / `*.localhost`) by default, per-launch RPC token, strict `Origin` and `Host` checks, and explicit `--host` opt-in for remote binds.
- **I9 Adapter-agnostic core:** Core packages import only `@codecanvas/protocol`.
- **I10 Semantic references:** `.codecanvas/` references routes, components, states, data keys, and accessible roles/names rather than line numbers.

## Workspace Layout

```text
skills/codecanvas/
├── SKILL.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   └── ARCHITECTURE.md
└── packages/
    ├── protocol/   # @codecanvas/protocol: JSON-RPC envelope, security types, adapter seams
    └── daemon/     # @codecanvas/daemon: loopback HTTP/WS JSON-RPC, editor, and gateway servers
```

## Running Locally

```bash
cd skills/codecanvas
pnpm install
pnpm -r --if-present typecheck
pnpm test
pnpm build
```

Start the daemon (binds to `127.0.0.1` on dynamic ports by default; pass `--host <addr>` only when explicitly opting into non-loopback access):

```bash
node packages/daemon/dist/cli.js
```
