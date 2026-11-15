// The audit's own images, pinned to the multi-arch index digest (amd64 and arm64) read on Nov 15,
// 2026, so a replay runs on the same bytes on every machine until the table is refreshed. An image
// the repo declares, or one passed with --image, is used as given.
export const IMAGE_DIGESTS: Record<string, string> = {
  "node:16-bookworm": "sha256:73e677f85fbc56d22c817b4e5d7f72086c5343c0859f3bf8aaadab22aab29ce6",
  "node:18-bookworm": "sha256:c6ae79e38498325db67193d391e6ec1d224d96c693a8a4d943498556716d3783",
  "node:20-bookworm": "sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5",
  "node:22-bookworm": "sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb",
  "node:24-bookworm": "sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496",
  "node:26-bookworm": "sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49",
  "python:3.9-slim": "sha256:2d97f6910b16bd338d3060f261f53f144965f755599aab1acda1e13cf1731b1b",
  "python:3.10-slim": "sha256:6ff506466f8b1e981719b468cc0023b8ef000b983cdec0eafe119d01f379e31d",
  "python:3.11-slim": "sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535",
  "python:3.12-slim": "sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b",
  "python:3.13-slim": "sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90",
  "python:3.14-slim": "sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f",
  "ghcr.io/astral-sh/uv:python3.9-bookworm-slim": "sha256:6821835eb4e0eb94d6a720d14a18ebcc3823ed323e61d346557a705cacf4757d",
  "ghcr.io/astral-sh/uv:python3.10-bookworm-slim": "sha256:a041b350d5d9483b538d5af07e9553ee8cbc7fc7fa90c2f7d20d93f18ce9bbd1",
  "ghcr.io/astral-sh/uv:python3.11-bookworm-slim": "sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36",
  "ghcr.io/astral-sh/uv:python3.12-bookworm-slim": "sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58",
  "ghcr.io/astral-sh/uv:python3.13-bookworm-slim": "sha256:531f855bda2c73cd6ef67d56b733b357cea384185b3022bd09f05e002cd144ca",
  "ghcr.io/astral-sh/uv:python3.14-bookworm-slim": "sha256:7cf77f594be8042dab6daa9fe326f90962252268b4f120a7f5dccce4d947e6c1",
};

// Node majors the audit has a pinned image for. Even majors are the LTS lines.
export const NODE_MAJORS = [16, 18, 20, 22, 24, 26];
export const DEFAULT_NODE = 22;
export const PYTHON_MINORS = ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"];

// The reference to pull: the tag pinned to its digest when the table has it.
export function pinnedRef(tag: string): string {
  const digest = IMAGE_DIGESTS[tag];
  return digest ? `${tag}@${digest}` : tag;
}

export function digestOf(tag: string): string | null {
  return IMAGE_DIGESTS[tag] ?? null;
}
