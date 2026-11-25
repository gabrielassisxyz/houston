/**
 * Work dashboard URL validator.
 *
 * The work dashboard is a page served by a local collector program on the
 * work machine, framed inside Houston at the route /work. This module decides
 * which addresses may be stored for it: only this machine on 127.0.0.1,
 * without credentials, query or fragment. Kept free of imports so
 * scripts/test-loopback-url.mjs can load it directly, like lib/request-guard.ts.
 */

export type WorkDashboardUrlOk = { ok: true; url: string };

export type WorkDashboardUrlErr = { ok: false; reason: string };

export type WorkDashboardUrlResult = WorkDashboardUrlOk | WorkDashboardUrlErr;

/**
 * Check a candidate work dashboard address.
 *
 * Answers `{ ok: true, url }` with the parser's normalised `href`, or
 * `{ ok: false, reason }` with a non-empty sentence.
 */
export function checkWorkDashboardUrl(value: unknown): WorkDashboardUrlResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "Work dashboard URL must be a string." };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Work dashboard URL must not be empty." };
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { ok: false, reason: "Work dashboard URL must not contain control characters." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Work dashboard URL is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Work dashboard URL must use http or https." };
  }
  if (parsed.username !== "") {
    return { ok: false, reason: "Work dashboard URL must not include a username." };
  }
  if (parsed.password !== "") {
    return { ok: false, reason: "Work dashboard URL must not include a password." };
  }
  if (parsed.hostname !== "127.0.0.1") {
    return { ok: false, reason: "Work dashboard URL must point at 127.0.0.1." };
  }
  if (parsed.href.includes("?") || parsed.href.includes("#")) {
    return { ok: false, reason: "Work dashboard URL must not include a query or a fragment." };
  }
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: "Work dashboard URL must use a port from 1 to 65535." };
    }
  }
  return { ok: true, url: parsed.href };
}
