import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeEnvImages, removeLeftoverContainers } from "./container.ts";
import { LEASE_HOURS, lease } from "./session.ts";
import { TEMP_MARK } from "./teardown.ts";
import { exists, readJson } from "./util.ts";
import type { LocalInfo, Paths } from "./workspace.ts";
import { currentDraftId, discardDraft, strayDrafts } from "./workspace.ts";

// What earlier audits left behind: this repo's drafts that no session holds, and on this machine
// the temp folders and containers audits name as theirs, once they are older than a lease, so an
// audit running now in another checkout keeps its own. The open draft is never touched.
export function cleanupLeftovers(p: Paths, opts: { images?: boolean } = {}, now = Date.now()): string[] {
  const removed: string[] = [];
  const open = currentDraftId(p);
  const held = open && lease(p.repo, now).valid ? open : null;
  for (const id of [...strayDrafts(p), ...(open && !held ? [open] : [])]) {
    discardDraft(p, id);
    removed.push(`draft ${id}`);
  }
  const keepTree = held && exists(join(p.work, held, "local.json")) ? basename(dirname(readJson<LocalInfo>(join(p.work, held, "local.json")).tree)) : null;
  const age = LEASE_HOURS * 3600e3;
  const tmp = tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith("readiness-") || name === keepTree) continue;
    const full = join(tmp, name);
    if (!exists(join(full, TEMP_MARK))) continue;
    try {
      if (!(now - statSync(full).mtimeMs > age)) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(`temp folder ${full}`);
    } catch {
      continue;
    }
  }
  removed.push(...removeLeftoverContainers(age, held, now));
  if (opts.images) removed.push(...removeEnvImages());
  return removed;
}
