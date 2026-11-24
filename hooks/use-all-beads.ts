"use client";
import * as React from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ALL_BEADS_STREAM_URL, type BeadsResponse } from "@/lib/api-client";
import { namespaceId, type AllBeadsResponse } from "@/lib/aggregate";
import { putBead, setBeadStatus, takeBead } from "@/lib/merged-list";
import type { Bead } from "@/lib/schema";

/** Not derived from a project id: a folder named "all" would get the id `all`. */
export const allBeadsKey = ["all-beads"] as const;

export function useAllBeads() {
  return useQuery({
    queryKey: allBeadsKey,
    queryFn: async () => keepPendingStatuses(await api.allBeads()),
    refetchInterval: (q) => q.state.data?.meta.pollIntervalMs ?? 5000,
  });
}

/** Refetch the merged list when any project changes; the poll interval is only the fallback. */
export function useAllBeadsStream(): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    const es = new EventSource(ALL_BEADS_STREAM_URL);
    es.addEventListener("change", () => {
      qc.invalidateQueries({ queryKey: allBeadsKey });
    });
    return () => es.close();
  }, [qc]);
}

function isDeletion(answer: unknown): answer is { deleted: string } {
  return typeof (answer as { deleted?: unknown } | null)?.deleted === "string";
}

function isBead(answer: unknown): answer is Bead {
  const bead = answer as Partial<Bead> | null;
  return typeof bead?.id === "string" && Array.isArray(bead.dependencies);
}

/**
 * Puts a write's answer into the merged list, so the page shows it without reading every project
 * again. A read of every project that started before the write would land after it with the old
 * values, so it is cancelled first.
 */
export async function reconcileAnswer(
  qc: QueryClient,
  projectId: string,
  answer: unknown,
): Promise<void> {
  if (qc.getQueryData(allBeadsKey) === undefined) return;
  await qc.cancelQueries({ queryKey: allBeadsKey });
  qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) => {
    if (isDeletion(answer)) return takeBead(data, projectId, answer.deleted);
    if (isBead(answer)) return keepPendingStatuses(putBead(data, projectId, answer));
    return data;
  });
}

interface StatusRun {
  projectId: string;
  localId: string;
  /** The status the newest write of the run is setting. */
  shown: string;
  /** The status the tracker last confirmed; undefined when the merged list did not hold the bead. */
  confirmed: string | undefined;
  /** Settles when the newest write of the run has settled. */
  tail: Promise<void>;
  open: number;
}

/** Module scope, so a remount of the board or the panel does not lose a bead's place in line. */
const statusRuns = new Map<string, StatusRun>();

/**
 * Keeps the status of every write still on its way on top of data that arrives meanwhile. A
 * tracker changes its files in two steps and the page is told at the first, so the read that
 * follows can still carry the status from before the write, and so can the answer of another
 * write to the same bead. Measured on a real `br` tracker: one status change in seven. Left
 * alone, the card goes back for a moment, and a drop made in that moment is taken for a move
 * inside its old column and writes nothing.
 */
function keepPendingStatuses<T extends AllBeadsResponse | undefined>(data: T): T {
  let next: AllBeadsResponse | undefined = data;
  for (const run of statusRuns.values()) next = setBeadStatus(next, run.projectId, run.localId, run.shown);
  return next as T;
}

/** The same for a read of one project's own list, where a bead goes by its own id. */
export function keepProjectPendingStatuses(projectId: string, data: BeadsResponse): BeadsResponse {
  const pending = new Map<string, string>();
  for (const run of statusRuns.values()) if (run.projectId === projectId) pending.set(run.localId, run.shown);
  if (pending.size === 0) return data;
  const beads = data.beads.map((bead) => {
    const status = pending.get(bead.id);
    return status === undefined ? bead : { ...bead, status };
  });
  return { ...data, beads };
}

export interface StatusTurn {
  /** Settles once the merged list shows the new status. */
  shown: Promise<void>;
  /** Settles once every earlier status write to the same bead has settled. */
  ready: Promise<void>;
  /** Called once per write: with the answer, or with undefined for a refusal. */
  settle: (answer: Bead | undefined) => Promise<void>;
}

function restoreStatus(
  qc: QueryClient,
  projectId: string,
  localId: string,
  confirmed: string | undefined,
): void {
  if (confirmed !== undefined) {
    qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) =>
      setBeadStatus(data, projectId, localId, confirmed),
    );
  }
  // A refused write changed no tracker, so no stream event would bring back a read it cancelled.
  void qc.invalidateQueries({ queryKey: allBeadsKey });
}

/**
 * Shows a status in the merged list before the tracker has answered. A read of every project
 * still in flight would land on top of it with the old status, and cancelling that read later
 * would put the list back to what it held when the read began, taking this status with it. So
 * the read is cancelled first, as before every other write to the merged list.
 */
async function showStatus(
  qc: QueryClient,
  projectId: string,
  localId: string,
  status: string,
): Promise<void> {
  if (qc.getQueryData(allBeadsKey) === undefined) return;
  await qc.cancelQueries({ queryKey: allBeadsKey });
  qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) =>
    setBeadStatus(data, projectId, localId, status),
  );
}

/**
 * Starts one status write of one bead: the merged list shows the new status, and the write gets
 * its place in line. Two `br` commands sent together can land in either order and leave the
 * tracker on the first, so writes to one bead are sent one at a time in the order they were asked
 * for. Must be called synchronously from the caller's `mutate`, which is what fixes that order.
 */
export function startStatusWrite(
  qc: QueryClient,
  projectId: string,
  localId: string,
  status: string,
): StatusTurn {
  const key = namespaceId(projectId, localId);
  let run = statusRuns.get(key);
  if (!run) {
    const held = qc.getQueryData<AllBeadsResponse>(allBeadsKey)?.beads.find((b) => b.id === key);
    run = { projectId, localId, shown: status, confirmed: held?.status, tail: Promise.resolve(), open: 0 };
    statusRuns.set(key, run);
  }
  run.shown = status;
  const shown = showStatus(qc, projectId, localId, status);
  const ready = run.tail;
  let release = (): void => {};
  run.tail = new Promise<void>((resolve) => (release = resolve));
  run.open += 1;
  const current = run;
  return {
    shown,
    ready,
    settle: (answer) => {
      if (answer) current.confirmed = answer.status;
      current.open -= 1;
      release();
      // Only the last write of a run touches the list: an earlier answer would show a status
      // that a write still on its way is about to replace.
      if (current.open > 0) return Promise.resolve();
      statusRuns.delete(key);
      if (answer) return reconcileAnswer(qc, projectId, answer);
      restoreStatus(qc, projectId, localId, current.confirmed);
      return Promise.resolve();
    },
  };
}
