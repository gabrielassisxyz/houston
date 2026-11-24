"use client";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/components/error-toast";
import { api, type BeadsResponse } from "@/lib/api-client";
import type { Bead, CreateInput, UpdateInput, DepType } from "@/lib/schema";
import { useApp } from "@/components/app-context";
import { ALL_PROJECT_ID } from "@/lib/aggregate";
import { keepProjectPendingStatuses, reconcileAnswer, startStatusWrite } from "@/hooks/use-all-beads";

/** Query key is scoped per project so tabs on different projects never collide. */
export const beadsKey = (projectId: string) => ["beads", projectId] as const;
export const activityKey = (projectId: string) => ["activity", projectId] as const;

export function useBeads(projectId: string) {
  return useQuery({
    queryKey: beadsKey(projectId),
    queryFn: async () => keepProjectPendingStatuses(projectId, await api.list(projectId)),
    refetchInterval: (q) => q.state.data?.meta.pollIntervalMs ?? 5000,
  });
}

/** Recent activity feed for a project. Invalidated by the SSE stream on change;
 *  the interval is just a fallback. */
export function useActivity(projectId: string) {
  return useQuery({
    queryKey: activityKey(projectId),
    queryFn: () => api.activity(projectId),
    refetchInterval: 20000,
  });
}

/** Flow-metrics for the Insights dashboard over a rolling window of `days`. */
export function useInsights(projectId: string, days: number) {
  return useQuery({
    queryKey: ["insights", projectId, days],
    queryFn: () => api.insights(projectId, days),
    refetchInterval: 30000,
  });
}

/** Gamification XP/level stats. Only enabled when the feature is opted in. */
export function useGamification(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["gamification", projectId],
    queryFn: () => api.gamification(projectId),
    enabled,
    refetchInterval: 30000,
  });
}

function patchCache(
  prev: BeadsResponse | undefined,
  id: string,
  patch: Partial<Bead>,
): BeadsResponse | undefined {
  if (!prev) return prev;
  return {
    ...prev,
    beads: prev.beads.map((b) => (b.id === id ? { ...b, ...patch } : b)),
  };
}

export interface SetStatusInput {
  id: string;
  status: string;
  reason?: string;
  /** The bead's own project, for a caller whose page is not that project. */
  projectId?: string;
}

export function useSetStatus() {
  const { projectId: pageProject } = useApp();
  const qc = useQueryClient();
  const target = (vars: SetStatusInput) => vars.projectId ?? pageProject;
  return useMutation({
    mutationFn: (vars: SetStatusInput) =>
      api.setStatus(target(vars), vars.id, vars.status, vars.reason),
    onMutate: async (vars) => {
      const projectId = target(vars);
      // The all-projects page is no project: every write route answers 404 for it.
      if (projectId === ALL_PROJECT_ID) throw new Error("This status change names no project to send it to");
      const turn = startStatusWrite(qc, projectId, vars.id, vars.status);
      await turn.shown;
      const key = beadsKey(projectId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<BeadsResponse>(key);
      qc.setQueryData<BeadsResponse>(key, (p) => patchCache(p, vars.id, { status: vars.status }));
      await turn.ready;
      return { prev, key, turn };
    },
    onSuccess: (answer, _vars, ctx) => ctx.turn.settle(answer),
    onError: (err, _vars, ctx) => {
      if (ctx) {
        if (ctx.prev) qc.setQueryData(ctx.key, ctx.prev);
        void ctx.turn.settle(undefined);
      }
      toastError(err);
    },
    onSettled: (_answer, _err, _vars, ctx) =>
      ctx ? qc.invalidateQueries({ queryKey: ctx.key }) : undefined,
  });
}

function mutationToast<TArgs, TRes>(
  fn: (args: TArgs) => Promise<TRes>,
  message: (args: TArgs, res: TRes) => string,
  qc: ReturnType<typeof useQueryClient>,
  key: readonly unknown[],
) {
  return {
    mutationFn: fn,
    // Returned, so the caller's own callbacks run only once the answer is in the merged list.
    onSuccess: (res: TRes, args: TArgs) => {
      const reconciled = reconcileAnswer(qc, String(key[1]), res);
      toast.success(message(args, res));
      qc.invalidateQueries({ queryKey: key });
      return reconciled;
    },
    onError: (err: unknown) => toastError(err),
  };
}

export function useCreateBead() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<CreateInput, Bead>(
      (input) => api.create(projectId, input),
      (_a, res) => `Created ${res.id} · create`,
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useUpdateBead() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; patch: UpdateInput }, Bead>(
      ({ id, patch }) => api.update(projectId, id, patch),
      () => "Updated · update",
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useEditLabels() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; edit: { add?: string[]; remove?: string[] } }, Bead>(
      ({ id, edit }) => api.editLabels(projectId, id, edit),
      () => "Updated · labels",
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useDeleteBead() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<string, { deleted: string }>(
      (id) => api.remove(projectId, id),
      (id) => `Deleted ${id} · delete`,
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useAddComment() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; text: string }, Bead>(
      ({ id, text }) => api.addComment(projectId, id, text),
      () => "Comment added",
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useAddDep() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; dependsOnId: string; type: DepType }, Bead>(
      ({ id, dependsOnId, type }) => api.addDep(projectId, id, dependsOnId, type),
      () => "Dependency added · dep add",
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useRemoveDep() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; dependsOnId: string }, Bead>(
      ({ id, dependsOnId }) => api.removeDep(projectId, id, dependsOnId),
      () => "Dependency removed · dep remove",
      qc,
      beadsKey(projectId),
    ),
  );
}

/** Create a human approval gate blocking `id` (bd gate create --type human). */
export function useCreateGate() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; reason?: string }, Bead>(
      ({ id, reason }) => api.createGate(projectId, id, reason),
      (_a, res) => `Created approval gate ${res.id} · gate create`,
      qc,
      beadsKey(projectId),
    ),
  );
}

/** "Needs You" inbox: respond (comment + close) or dismiss (drop the human label). */
export function useRespondHuman() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string; text: string }, Bead>(
      ({ id, text }) => api.human.respond(projectId, id, text),
      (a) => `Responded to ${a.id}`,
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useDismissHuman() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<{ id: string }, Bead>(
      ({ id }) => api.human.dismiss(projectId, id),
      (a) => `Dismissed ${a.id}`,
      qc,
      beadsKey(projectId),
    ),
  );
}

export function useArchiveBead() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation(
    mutationToast<string, Bead>(
      (id) => api.archive(projectId, id),
      (id) => `Archived ${id} · close + label`,
      qc,
      beadsKey(projectId),
    ),
  );
}
