import { languageImages } from "./languages/index.ts";

// The audit's own images, pinned to the multi-arch index digest (amd64 and arm64) read on Nov 15,
// 2026, so a replay runs on the same bytes on every machine until the table is refreshed. An image
// the repo declares, or one passed with --image, is used as given. The uv images, read on Nov 27,
// are on Debian trixie like python:*-slim, so the git the audit adds to them is trixie's 2.47, not
// bookworm's 2.39, which fails tests that pass with the git on current CI runners.
// A language file's own images (languages/*.ts `replay.images`) are added to these.
const BASE_DIGESTS: Record<string, string> = {
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
  "ghcr.io/astral-sh/uv:python3.9-trixie-slim": "sha256:8f0d49ccab34876916fe67c6190fdf14c31cf64153dc08b73664162342f50feb",
  "ghcr.io/astral-sh/uv:python3.10-trixie-slim": "sha256:059b33d17906ee8536034962b0b6eb82b0551584fb849a14e417bb86dbb27087",
  "ghcr.io/astral-sh/uv:python3.11-trixie-slim": "sha256:e91362c13eaf2fbe46161077a5a0092d14a01f5de3684e78d9f66484988e8fce",
  "ghcr.io/astral-sh/uv:python3.12-trixie-slim": "sha256:a3fdff607889036fef414975e3701d14a2b6734ffec10cbdd5ce60d2b6c8853a",
  "ghcr.io/astral-sh/uv:python3.13-trixie-slim": "sha256:00e2b362982a5ce19eb3a51453ed76af92ccaaedccc0236fae83b27d994ae0f3",
  "ghcr.io/astral-sh/uv:python3.14-trixie-slim": "sha256:b093dbbd7963c765325ecdf866d42915f5327e135569f9dae9c77cac63559bf2",
};

export const IMAGE_DIGESTS: Record<string, string> = { ...BASE_DIGESTS, ...languageImages() };

export { DEFAULT_NODE, NODE_MAJORS } from "./languages/node.ts";
export const PYTHON_MINORS = ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"];

// The reference to pull: the tag pinned to its digest when the table has it.
export function pinnedRef(tag: string): string {
  const digest = IMAGE_DIGESTS[tag];
  return digest ? `${tag}@${digest}` : tag;
}

export function digestOf(tag: string): string | null {
  return IMAGE_DIGESTS[tag] ?? null;
}
