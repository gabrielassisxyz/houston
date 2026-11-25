"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WorkProbeResponse } from "@/lib/api-client";

/**
 * Whether the configured work dashboard answers. One query under
 * `["work-probe", url]`, enabled only when the capabilities read succeeded
 * with a URL. Returning to the tab or reconnecting never probes again while
 * `/work` is mounted, so a collector that is slow for a moment never
 * unmounts a frame the user is working in; leaving `/work` drops the cached
 * answer (`gcTime: 0`), so coming back probes afresh instead of trusting an
 * answer up to five minutes old.
 *
 * The query function invalidates `["capabilities"]` when the answer has
 * `configured: false`, never the render, so the sidebar and the page learn
 * that the key is gone.
 */
export function useWorkProbe(url: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["work-probe", url],
    queryFn: async ({ signal }): Promise<WorkProbeResponse> => {
      const answer = await api.workProbe(signal);
      if (!answer.configured) {
        void qc.invalidateQueries({ queryKey: ["capabilities"] });
      }
      return answer;
    },
    enabled: !!url,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
}
