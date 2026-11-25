import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The audit's session: a lease that says an audit is under way in this checkout, so the guard
// enforces only while one is. `readiness session start` opens it at preflight, before `init`;
// `init` attaches its draft. The seal, `session end` and expiry release it. A lease counts only
// while it hasn't expired and, once a draft is attached, while that draft exists, so a crash, a
// deleted draft or a half-written file can never hold the repo. The guard loads this file, so it
// depends on nothing but Node.

export const SESSION_FILE = ".agent-readiness/work/session.json";
// Long enough for an audit with its diagnosis, short enough that a session left behind lets go the
// same day. Every write to the draft renews it.
export const LEASE_HOURS = 4;

// The user's yes to running repo commands outside a container, for this session's audit only.
export interface ExecutionGrant {
  scope: "host";
  note: string;
  at: string;
}

export interface Session {
  schema: "agent-readiness/session@1";
  id: string;
  startedAt: string;
  expiresAt: string;
  auditId: string | null;
  grant: ExecutionGrant | null;
}

export interface Lease {
  session: Session | null;
  valid: boolean;
  // Why there is no valid lease, when there isn't.
  why: string | null;
}

const file = (repo: string) => join(repo, SESSION_FILE);
const draftExists = (repo: string, id: string) => existsSync(join(repo, ".agent-readiness", "work", id, "audit.json"));
const iso = (ms: number) => new Date(ms).toISOString();

export function readSession(repo: string): Session | null {
  try {
    const s = JSON.parse(readFileSync(file(repo), "utf8")) as Session;
    return s && s.schema === "agent-readiness/session@1" && typeof s.expiresAt === "string" ? s : null;
  } catch {
    return null;
  }
}

export function lease(repo: string, now = Date.now()): Lease {
  const session = readSession(repo);
  if (!session) return { session: null, valid: false, why: existsSync(file(repo)) ? "the session file can't be read" : "no session is open" };
  if (!(Date.parse(session.expiresAt) > now)) return { session, valid: false, why: `the session expired at ${session.expiresAt}` };
  if (session.auditId && !draftExists(repo, session.auditId)) return { session, valid: false, why: `its draft ${session.auditId} no longer exists` };
  return { session, valid: true, why: null };
}

function write(repo: string, s: Session): Session {
  mkdirSync(dirname(file(repo)), { recursive: true });
  writeFileSync(file(repo), JSON.stringify(s, null, 2) + "\n");
  return s;
}

// Opens a session, or renews the valid one. An expired or broken one is replaced, keeping nothing.
export function startSession(repo: string, now = Date.now()): { session: Session; renewed: boolean } {
  const l = lease(repo, now);
  if (l.valid && l.session) return { session: write(repo, { ...l.session, expiresAt: iso(now + LEASE_HOURS * 3600e3) }), renewed: true };
  const s: Session = { schema: "agent-readiness/session@1", id: `ses-${randomBytes(4).toString("hex")}`, startedAt: iso(now), expiresAt: iso(now + LEASE_HOURS * 3600e3), auditId: null, grant: null };
  return { session: write(repo, s), renewed: false };
}

// `init` attaches its draft to the open session, or opens one. The user's yes carries over: it was
// given for the audit this session is for.
export function attachAudit(repo: string, auditId: string, now = Date.now()): Session {
  const { session } = startSession(repo, now);
  return write(repo, { ...session, auditId });
}

export function renewSession(repo: string, now = Date.now()): void {
  const l = lease(repo, now);
  if (l.valid && l.session) write(repo, { ...l.session, expiresAt: iso(now + LEASE_HOURS * 3600e3) });
}

export function recordGrant(repo: string, note: string, at: string, now = Date.now()): Session {
  const { session } = startSession(repo, now);
  return write(repo, { ...session, grant: { scope: "host", note, at } });
}

export function endSession(repo: string): boolean {
  const had = existsSync(file(repo));
  rmSync(file(repo), { force: true });
  return had;
}

// Whether a valid session holds the user's yes.
export function grantRecorded(repo: string, now = Date.now()): boolean {
  const l = lease(repo, now);
  return l.valid && Boolean(l.session?.grant);
}
