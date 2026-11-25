"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface Capabilities {
  workDashboardUrl: string | undefined;
  chain: boolean;
}

/**
 * Which optional features the server offers. One query under
 * `["capabilities"]`, with `retry: false` and the app's global defaults
 * otherwise (two-second stale time, refetch on focus): a tab left open sees
 * a restarted or reconfigured server, without TanStack's default three
 * retries when the read fails.
 *
 * A successful body without a string `workDashboardUrl` that is non-empty
 * after trimming is normalised to unset, because some browser fixtures
 * answer an unknown read with `{}`. A failed request stays a query error.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: async ({ signal }): Promise<Capabilities> => {
      const body = await api.capabilities(signal);
      const raw = (body as { workDashboardUrl?: unknown } | null)?.workDashboardUrl;
      const chain = (body as { chain?: unknown } | null)?.chain === true;
      if (typeof raw === "string" && raw.trim() !== "") return { workDashboardUrl: raw.trim(), chain };
      return { workDashboardUrl: undefined, chain };
    },
    retry: false,
  });
}
