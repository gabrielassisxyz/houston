"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { ALL_PROJECT_ID } from "@/lib/aggregate";

/** Query key for one bead's chain, scoped by its own project and id. */
export const chainKey = (projectId: string, beadId: string) => ["chain", projectId, beadId] as const;

/**
 * One TanStack Query read per bead for its chain. Enabled only when asked and
 * never for the pseudo project `@all`: every write route answers 404 for it.
 */
export function useChain(projectId: string, beadId: string, enabled = true) {
  return useQuery({
    queryKey: chainKey(projectId, beadId),
    queryFn: ({ signal }) => api.chain(projectId, beadId, signal),
    enabled: enabled && !!projectId && !!beadId && projectId !== ALL_PROJECT_ID,
    retry: false,
  });
}
