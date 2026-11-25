/**
 * Outbound link builder.
 *
 * Decides where a link from Houston may point: a ticket record's own link
 * only when it is an HTTPS address on the configured ServiceNow host, a pull
 * request or run link only for a repository whose owner is in the configured
 * GitHub owners, and a change link through its record's own link or, when the
 * changes source has no record of it, the standard change form on that same
 * host. Every function answers a URL string or `null`, and `null` means the
 * identifier is shown as plain text. A setting that is unset, or holds a value its rule
 * refuses, yields `null` for every link that needs it.
 *
 * Imports only ./config-values, so the host, owner and repository rules are
 * the ones the config keys are validated with, and a pure script can load it
 * without a build.
 */

import { checkGithubOrgs, checkPipelineRepo, checkServiceNowHost, checkTicketNumber } from "./config-values";

export type LinkSettings = {
  serviceNowHost?: string | null;
  githubOrgs?: readonly string[] | null;
};

/** A record of the changes source, as far as a change link reads it. */
export type ChangeRecord = { number: string; link: string };

const HTTPS_PREFIX = "https://";

// Only ASCII host characters: the parser would decode `exam%70le.com` and a
// fullwidth `ｅxample.com` into `example.com`, which is not what the record said.
const RAW_AUTHORITY = /^[A-Za-z0-9.-]+(:[0-9]+)?$/;

const STANDARD_CHANGE_FORM = "/change_request.do?sysparm_query=number=";

function allowedTicketHost(settings: LinkSettings): string | null {
  const host = checkServiceNowHost(settings.serviceNowHost);
  return host.ok ? host.value : null;
}

// The URL parser silently repairs `https://@example.com/`, `https:@example.com/`,
// `https:///example.com/` and `https://example.com:/` into
// `https://example.com/`, and drops tabs, newlines and leading spaces, so these
// are refused on the raw string before it is parsed.
function hasTicketLinkShape(raw: string): boolean {
  if (/[\s\x00-\x1F\x7F\\]/.test(raw)) return false;
  if (!raw.startsWith(HTTPS_PREFIX)) return false;
  const rest = raw.slice(HTTPS_PREFIX.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return RAW_AUTHORITY.test(authority);
}

/**
 * Vet a ticket record's own link.
 *
 * Answers the parser's canonical `href` when the raw string has the shape
 * above, parses as `https:` on exactly the configured ServiceNow host, with no
 * user name, password or port (an explicit `:443` parses to no port); `null`
 * otherwise.
 */
export function ticketLink(raw: unknown, settings: LinkSettings): string | null {
  const host = allowedTicketHost(settings);
  if (host === null) return null;
  if (typeof raw !== "string" || !hasTicketLinkShape(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== host) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.port !== "") return null;
  return parsed.href;
}

function allowedRepo(repo: unknown, settings: LinkSettings): string | null {
  const checked = checkPipelineRepo(repo);
  if (!checked.ok) return null;
  const owners = checkGithubOrgs(settings.githubOrgs);
  if (!owners.ok) return null;
  const owner = checked.value.split("/")[0];
  return owners.value.includes(owner) ? checked.value : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Build `https://github.com/<owner>/<name>/pull/<number>`, or `null`. */
export function pullRequestLink(repo: unknown, number: unknown, settings: LinkSettings): string | null {
  const allowed = allowedRepo(repo, settings);
  if (allowed === null || !isPositiveSafeInteger(number)) return null;
  return `https://github.com/${allowed}/pull/${number}`;
}

/** Build `https://github.com/<owner>/<name>/actions/runs/<id>`, or `null`. */
export function runLink(repo: unknown, id: unknown, settings: LinkSettings): string | null {
  const allowed = allowedRepo(repo, settings);
  if (allowed === null || !isPositiveSafeInteger(id)) return null;
  return `https://github.com/${allowed}/actions/runs/${id}`;
}

/**
 * Link a change number from a run's `changes`.
 *
 * The number is trimmed and matched against each record's trimmed `number`
 * without regard to case, as the snapshot's ticket lookup matches. A record
 * found links through its own link, vetted by `ticketLink`, and a record whose
 * link fails gets no link at all rather than the fallback. Only when no record
 * matches, and the trimmed number has the ticket-number shape, is the standard
 * change form on the ServiceNow host built. That form is provisional until the
 * route the work dashboard opens a change with is confirmed.
 */
export function changeLink(number: unknown, changes: readonly ChangeRecord[], settings: LinkSettings): string | null {
  if (typeof number !== "string") return null;
  const trimmed = number.trim();
  if (trimmed === "") return null;
  const needle = trimmed.toLowerCase();
  const record = changes.find((entry) => entry.number.trim().toLowerCase() === needle);
  if (record !== undefined) return ticketLink(record.link, settings);
  if (!checkTicketNumber(trimmed).ok) return null;
  const host = allowedTicketHost(settings);
  if (host === null) return null;
  return `${HTTPS_PREFIX}${host}${STANDARD_CHANGE_FORM}${trimmed}`;
}
