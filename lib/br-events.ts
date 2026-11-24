import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawInteraction } from "./interactions";

/**
 * Status and priority history for a `br` project, read from `br audit log`.
 *
 * `br` has no interactions.jsonl; its history lives in an events table that is
 * only reachable one bead per process. Reading that table directly would be one
 * query, but it couples the app to br's internal schema, which changed twice in
 * 2026 and would surface as an empty feed. So: one `br audit log <id>` per bead,
 * cached by bead id and `updated_at` (every change to a bead moves it), with a
 * bounded number of processes at once.
 */

const pExecFile = promisify(execFile);
const BR_BIN = process.env.BR_BIN || "br";

export const MAX_CONCURRENT_BR = 8;

export type BrRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

const realRunner: BrRunner = (cmd, args, opts) =>
  pExecFile(cmd, args, { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });

interface BrHistoryEvent {
  event_type?: string;
  actor?: string;
  timestamp?: string;
  old_value?: string;
  new_value?: string;
}

const FIELD_OF: Record<string, "status" | "priority"> = {
  status_changed: "status",
  priority_changed: "priority",
};

/** br stamps nanoseconds; milliseconds are what Date.parse is specified for. */
function toMillis(ts: string | undefined): string | undefined {
  return ts?.replace(/(\.\d{3})\d+/, "$1");
}

/** Pure mapping of one `br audit log --json` payload; other event types are dropped. */
export function mapAuditLog(issueId: string, stdout: string): RawInteraction[] {
  const parsed = JSON.parse(stdout) as { events?: BrHistoryEvent[] };
  const out: RawInteraction[] = [];
  for (const e of parsed.events ?? []) {
    const field = FIELD_OF[e.event_type ?? ""];
    if (!field) continue;
    out.push({
      kind: "field_change",
      issue_id: issueId,
      created_at: toMillis(e.timestamp),
      actor: e.actor,
      extra: { field, old_value: e.old_value, new_value: e.new_value },
    });
  }
  return out;
}

// repoPath -> bead id -> events valid for that `updated_at`. Replacing the entry
// when `updated_at` moves keeps one generation per bead instead of growing.
const cache = new Map<string, Map<string, { updatedAt: string; events: RawInteraction[] }>>();

type BeadRef = { id: string; updated_at?: string };
const stamp = (b: BeadRef) => b.updated_at ?? "";

function repoCacheFor(repoPath: string) {
  let repoCache = cache.get(repoPath);
  if (!repoCache) cache.set(repoPath, (repoCache = new Map()));
  return repoCache;
}

// The bound and the in-flight table are per process, not per call. When a project opens, the
// activity, insights and gamification routes all ask for the same history at the same moment;
// bounded per call, that was three processes per bead and up to 24 at once.
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_BR) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    // A waiter inherits the slot as it is, so nothing arriving in between can take it too.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const inflight = new Map<string, Promise<RawInteraction[] | null>>();

/** One bead's history, shared by every caller that asks while it is being fetched. */
function fetchBead(repoPath: string, b: BeadRef, run: BrRunner): Promise<RawInteraction[] | null> {
  const key = `${repoPath}\n${b.id}\n${stamp(b)}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const fetched = withSlot(async () => {
    try {
      const { stdout } = await run(BR_BIN, ["audit", "log", b.id, "--json"], { cwd: repoPath });
      const events = mapAuditLog(b.id, stdout);
      repoCacheFor(repoPath).set(b.id, { updatedAt: stamp(b), events });
      return events;
    } catch (err) {
      // Not cached, so the next read tries this bead again.
      console.error(`br audit log failed for ${b.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }).finally(() => inflight.delete(key));
  inflight.set(key, fetched);
  return fetched;
}

export async function readBrEvents(
  repoPath: string,
  beads: ReadonlyArray<BeadRef>,
  run: BrRunner = realRunner,
): Promise<RawInteraction[]> {
  const store = repoCacheFor(repoPath);
  const perBead = await Promise.all(
    beads.map((b) => {
      const hit = store.get(b.id);
      return hit && hit.updatedAt === stamp(b) ? hit.events : fetchBead(repoPath, b, run);
    }),
  );
  return perBead.flatMap((events) => events ?? []);
}
