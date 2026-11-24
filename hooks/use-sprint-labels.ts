"use client";
import * as React from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { projectOf, type AllBead, type AllBeadsResponse } from "@/lib/aggregate";
import { sprintIdsOf, sprintLabel, type Size } from "@/lib/sprint-model";
import { allBeadsKey } from "@/hooks/use-all-beads";
import { toastError } from "@/components/error-toast";

export interface LabelEdit {
  add: string[];
  remove: string[];
}

/** Both keys are always sent; a bead is in one sprint at most, so any other sprint label goes. */
export function moveInEdit(labels: readonly string[], sprintId: string): LabelEdit {
  const target = sprintLabel(sprintId);
  const others = sprintIdsOf(labels).map(sprintLabel).filter((l) => l !== target);
  return { add: [target], remove: [...new Set(others)] };
}

export function moveOutEdit(sprintId: string): LabelEdit {
  return { add: [], remove: [sprintLabel(sprintId)] };
}

/** Null when the bead already has this size: nothing to send. */
export function sizeEdit(labels: readonly string[], size: Size): LabelEdit | null {
  const target = `size:${size}`;
  if (labels.includes(target) && labels.filter((l) => l.startsWith("size:")).length === 1) return null;
  return { add: [target], remove: labels.filter((l) => l.startsWith("size:") && l !== target) };
}

function applyEdit(labels: string[], edit: LabelEdit): string[] {
  const kept = labels.filter((l) => !edit.remove.includes(l));
  return [...kept, ...edit.add.filter((l) => !kept.includes(l))];
}

function patchLabels(data: AllBeadsResponse | undefined, id: string, change: (labels: string[]) => string[]) {
  if (!data) return data;
  return { ...data, beads: data.beads.map((b) => (b.id === id ? { ...b, labels: change(b.labels) } : b)) };
}

type Variables = { bead: AllBead; edit: LabelEdit };

const mutationKey = ["sprint-labels"] as const;

/**
 * Writes one bead's labels to the bead's own project and moves the row at once: waiting for the
 * refetch of every project's beads would make each click take about a second.
 */
export function useSprintLabels() {
  const qc = useQueryClient();
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const mutation = useMutation<unknown, Error, Variables, { before: string[] }>({
    mutationKey,
    // The project and the id come from the bead being moved and from nowhere else.
    mutationFn: ({ bead, edit }) => api.editLabels(projectOf(bead)!.id, bead.local_id, edit),
    onMutate: async ({ bead, edit }) => {
      mark(bead.id, true);
      await qc.cancelQueries({ queryKey: allBeadsKey });
      const before = qc.getQueryData<AllBeadsResponse>(allBeadsKey)?.beads.find((b) => b.id === bead.id)?.labels ?? bead.labels;
      qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) => patchLabels(data, bead.id, (l) => applyEdit(l, edit)));
      return { before };
    },
    onError: (error, { bead }, context) => {
      if (context) qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) => patchLabels(data, bead.id, () => context.before));
      toastError(error);
    },
    onSettled: (_data, _error, { bead }) => {
      mark(bead.id, false);
      // With several moves in flight, a refetch now would answer without the ones still on
      // their way and send those rows back for a moment. The last to settle refetches for all.
      if (qc.isMutating({ mutationKey }) === 1) void qc.invalidateQueries({ queryKey: allBeadsKey });
    },
  });

  return { edit: (bead: AllBead, edit: LabelEdit) => mutation.mutate({ bead, edit }), pending };
}

export interface Refusal {
  bead: AllBead;
  reason: string;
}

async function addOne(qc: QueryClient, bead: AllBead, sprintId: string): Promise<string | null> {
  const edit = moveInEdit(bead.labels, sprintId);
  try {
    await api.editLabels(projectOf(bead)!.id, bead.local_id, edit);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // A read of every project still in flight would land on top of this with the old labels.
  await qc.cancelQueries({ queryKey: allBeadsKey });
  qc.setQueryData<AllBeadsResponse>(allBeadsKey, (data) => patchLabels(data, bead.id, (l) => applyEdit(l, edit)));
  return null;
}

/**
 * Puts several beads into one sprint and answers with the ones that were refused, in the order
 * they were given. Nothing queues the writes to one tracker, and many `br` commands started
 * together on one tracker have never been tried, so the beads of a project are written one after
 * another; projects are written side by side. The list is read again once, after the last write.
 */
export function useAddToSprint() {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);

  const add = React.useCallback(
    async (beads: AllBead[], sprintId: string): Promise<Refusal[]> => {
      const byProject = new Map<string, AllBead[]>();
      for (const bead of beads) byProject.set(bead.project.id, [...(byProject.get(bead.project.id) ?? []), bead]);
      const reasons = new Map<string, string>();
      setBusy(true);
      try {
        await Promise.all(
          [...byProject.values()].map(async (ofProject) => {
            for (const bead of ofProject) {
              const reason = await addOne(qc, bead, sprintId);
              if (reason !== null) reasons.set(bead.id, reason);
            }
          }),
        );
      } finally {
        setBusy(false);
        void qc.invalidateQueries({ queryKey: allBeadsKey });
      }
      return beads.flatMap((bead) => {
        const reason = reasons.get(bead.id);
        return reason === undefined ? [] : [{ bead, reason }];
      });
    },
    [qc],
  );

  return { add, busy };
}
