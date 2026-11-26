"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface Capabilities {
  workDashboardUrl: string | undefined;
  chain: boolean;
  notes: boolean;
  obsidianVault: string | null;
}

/** The string trimmed, or `undefined` for anything else or a blank one. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read and normalise the capabilities body. A successful body without a
 * string `workDashboardUrl` that is non-empty after trimming is normalised
 * to unset, and every other field falls back to off the same way, because
 * some browser fixtures answer an unknown read with `{}`. A failed request
 * throws, so the caller sees a query error.
 */
export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  const body: unknown = await api.capabilities(signal);
  const fields = body as Partial<Record<keyof Capabilities, unknown>> | null;
  return {
    workDashboardUrl: nonBlank(fields?.workDashboardUrl),
    chain: fields?.chain === true,
    notes: fields?.notes === true,
    obsidianVault: nonBlank(fields?.obsidianVault) ?? null,
  };
}

/**
 * Which optional features the server offers. One query under
 * `["capabilities"]`, with `retry: false` and the app's global defaults
 * otherwise (two-second stale time, refetch on focus): a tab left open sees
 * a restarted or reconfigured server, without TanStack's default three
 * retries when the read fails.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: ({ signal }) => fetchCapabilities(signal),
    retry: false,
  });
}
