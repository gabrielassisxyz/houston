/**
 * Loopback URL validators.
 *
 * Two settings name a program running on this machine: the work dashboard, a
 * page served by a local collector program on the work machine and framed
 * inside Houston at the route /work, and the notes service, which Houston's
 * server side calls. This module decides which addresses may be stored for
 * each: this machine only, without credentials, query or fragment. Kept free
 * of imports so scripts/test-loopback-url.mjs can load it directly, like
 * lib/request-guard.ts.
 */

export type WorkDashboardUrlOk = { ok: true; url: string };

export type WorkDashboardUrlErr = { ok: false; reason: string };

export type WorkDashboardUrlResult = WorkDashboardUrlOk | WorkDashboardUrlErr;

export type LoopbackServiceUrlResult = WorkDashboardUrlResult;

/** Where the two settings differ. */
type LoopbackRules = {
  /** Names the setting at the start of every refusal. */
  subject: string;
  /** Accepted host names as the parser spells them, so IPv6 keeps its brackets. */
  hosts: readonly string[];
  hostRefusal: string;
  rootPathOnly: boolean;
};

const WORK_DASHBOARD: LoopbackRules = {
  subject: "Work dashboard URL",
  hosts: ["127.0.0.1"],
  hostRefusal: "must point at 127.0.0.1.",
  rootPathOnly: false,
};

// The hosts are the ones the notes service agrees to bind and its request guard
// lets through: any other loopback address would be answered 403. The path must
// be the root because the client builds every address with
// `new URL(path, base)`, which would silently drop a prefix.
const NOTES_SERVICE: LoopbackRules = {
  subject: "Notes service URL",
  hosts: ["127.0.0.1", "localhost", "[::1]"],
  hostRefusal: "must point at 127.0.0.1, localhost or [::1].",
  rootPathOnly: true,
};

/**
 * Check a candidate work dashboard address.
 *
 * Answers `{ ok: true, url }` with the parser's normalised `href`, or
 * `{ ok: false, reason }` with a non-empty sentence.
 */
export function checkWorkDashboardUrl(value: unknown): WorkDashboardUrlResult {
  return checkLoopbackUrl(value, WORK_DASHBOARD);
}

/**
 * Check a candidate notes service address: every rule of the work dashboard
 * address, with the notes service's own hosts and no path. Answers like
 * `checkWorkDashboardUrl`.
 */
export function checkLoopbackServiceUrl(value: unknown): LoopbackServiceUrlResult {
  return checkLoopbackUrl(value, NOTES_SERVICE);
}

function checkLoopbackUrl(value: unknown, rules: LoopbackRules): WorkDashboardUrlResult {
  const refuse = (rest: string): WorkDashboardUrlErr => ({ ok: false, reason: `${rules.subject} ${rest}` });
  if (typeof value !== "string") {
    return refuse("must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return refuse("must not be empty.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return refuse("must not contain control characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return refuse("is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse("must use http or https.");
  }
  if (parsed.username !== "") {
    return refuse("must not include a username.");
  }
  if (parsed.password !== "") {
    return refuse("must not include a password.");
  }
  if (!rules.hosts.includes(parsed.hostname)) {
    return refuse(rules.hostRefusal);
  }
  if (parsed.href.includes("?") || parsed.href.includes("#")) {
    return refuse("must not include a query or a fragment.");
  }
  if (rules.rootPathOnly && parsed.pathname !== "/") {
    return refuse("must not include a path.");
  }
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return refuse("must use a port from 1 to 65535.");
    }
  }
  return { ok: true, url: parsed.href };
}
