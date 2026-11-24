"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sprintsApi } from "@/lib/sprints-client";
import { allBeadsKey } from "@/hooks/use-all-beads";
import type { CreateSprintInput, PatchSprintInput } from "@/lib/sprint-model";

export const sprintsKey = ["sprints"] as const;

export function useSprints() {
  return useQuery({ queryKey: sprintsKey, queryFn: sprintsApi.list });
}

// Every write refetches the list, so a row never shows what the server no longer holds.
function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: sprintsKey }),
  });
}

export function useCreateSprint() {
  return useInvalidating((input: CreateSprintInput) => sprintsApi.create(input));
}

export function useUpdateSprint() {
  return useInvalidating((v: { id: string; patch: PatchSprintInput }) => sprintsApi.update(v.id, v.patch));
}

export function useDeleteSprint() {
  return useInvalidating((id: string) => sprintsApi.remove(id));
}

// Start and close change the labels of beads in several projects, so both lists are refetched,
// and also after a refusal: an unfinished close leaves the sprint `closing` and the page has to
// read that from the server to show what remains.
function useRunAction(fn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: sprintsKey }),
        qc.invalidateQueries({ queryKey: allBeadsKey }),
      ]),
  });
}

export function useStartSprint() {
  return useRunAction(sprintsApi.start);
}

export function useCloseSprint() {
  return useRunAction(sprintsApi.close);
}
