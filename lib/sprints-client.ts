import { ApiError } from "./api-client";
import type { CreateSprintInput, PatchSprintInput, Sprint } from "./sprint-model";

// `request` in api-client.ts is not exported, so the sprint calls repeat its shape: the server's
// `{error, code}` body becomes an ApiError the form and the toast can key off.
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string; detail?: string };
    throw new ApiError(b.error || `Request failed (${res.status})`, res.status, b.code, b.detail);
  }
  return body as T;
}

const sprintUrl = (id: string) => `/api/sprints/${encodeURIComponent(id)}`;

export const sprintsApi = {
  list: () => call<{ sprints: Sprint[] }>("/api/sprints", { cache: "no-store" }),
  create: (input: CreateSprintInput) =>
    call<Sprint>("/api/sprints", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: PatchSprintInput) =>
    call<Sprint>(sprintUrl(id), { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => call<unknown>(sprintUrl(id), { method: "DELETE" }),
  // Neither action takes a body: the server decides what to freeze or to release.
  start: (id: string) => call<Sprint>(`${sprintUrl(id)}/start`, { method: "POST" }),
  close: (id: string) => call<Sprint>(`${sprintUrl(id)}/close`, { method: "POST" }),
};
