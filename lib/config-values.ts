/**
 * Config value validators.
 *
 * Pure validators for the chain keys of step 3 (`snapshotPath`,
 * `serviceNowHost`, `githubOrgs`), the pipeline repository of step 5 and the
 * ticket-number shape of provisional decision 4, so steps 5 and 6 share one
 * definition, and for the Obsidian vault name. Kept free of imports so pure
 * scripts can load it directly, like `lib/loopback-url.ts`.
 *
 * Each answers `{ ok: true, value }` or `{ ok: false, reason }` with a
 * non-empty sentence, as phase 1's `checkWorkDashboardUrl` does. Accepted
 * values are returned as-is, except `checkGithubOrgs`, which returns a copy of
 * the patch's list so the stored value never aliases the caller's array, and
 * `checkObsidianVault`, which returns the trimmed name.
 */

export type StringCheck = { ok: true; value: string } | { ok: false; reason: string };

export type StringListCheck = { ok: true; value: string[] } | { ok: false; reason: string };

/**
 * Check a candidate snapshot path.
 *
 * A primitive string starting with `/`, with no ASCII control character and
 * no surrounding whitespace.
 */
export function checkSnapshotPath(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "Snapshot path must be a string." };
  }
  if (value === "") {
    return { ok: false, reason: "Snapshot path must not be empty." };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: "Snapshot path must not have surrounding whitespace." };
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return { ok: false, reason: "Snapshot path must not contain control characters." };
  }
  if (!value.startsWith("/")) {
    return { ok: false, reason: "Snapshot path must start with /." };
  }
  return { ok: true, value };
}

/**
 * Check a candidate Obsidian vault name: a string that is non-empty once
 * trimmed, with no ASCII control character.
 */
export function checkObsidianVault(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "Obsidian vault name must be a string." };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Obsidian vault name must not be empty." };
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { ok: false, reason: "Obsidian vault name must not contain control characters." };
  }
  return { ok: true, value: trimmed };
}

function isOwnerLabel(label: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/**
 * Check a candidate ServiceNow host.
 *
 * A bare host name of at least two dot-separated lowercase labels, each of
 * letters and digits with hyphens only inside, the last one holding at least
 * one letter, so a single-label name and an IPv4 literal are refused. No
 * leading or trailing dot or hyphen, no empty label, and no scheme, port,
 * path or user information.
 */
export function checkServiceNowHost(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "ServiceNow host must be a string." };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, reason: "ServiceNow host must not be empty." };
  }
  if (value !== trimmed) {
    return { ok: false, reason: "ServiceNow host must not have surrounding whitespace." };
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return { ok: false, reason: "ServiceNow host must not contain control characters." };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: "ServiceNow host must not contain whitespace." };
  }
  if (value.includes("@")) {
    return { ok: false, reason: "ServiceNow host must not include user information." };
  }
  if (value.includes("://")) {
    return { ok: false, reason: "ServiceNow host must not include a scheme." };
  }
  if (value.includes("/")) {
    return { ok: false, reason: "ServiceNow host must not include a path." };
  }
  if (value.includes("?") || value.includes("#")) {
    return { ok: false, reason: "ServiceNow host must not include a query or a fragment." };
  }
  if (value.includes(":")) {
    return { ok: false, reason: "ServiceNow host must not include a port." };
  }
  const labels = value.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: "ServiceNow host must have at least two dot-separated labels." };
  }
  for (const label of labels) {
    if (label === "") {
      return { ok: false, reason: "ServiceNow host must not have an empty label." };
    }
    if (!isOwnerLabel(label)) {
      return { ok: false, reason: "ServiceNow host labels must use lowercase letters and digits with hyphens only inside." };
    }
  }
  const last = labels[labels.length - 1];
  if (!/[a-z]/.test(last)) {
    return { ok: false, reason: "ServiceNow host's last label must hold at least one letter." };
  }
  return { ok: true, value };
}

/**
 * Check a single GitHub owner name: lowercase letters and digits with hyphens
 * only inside.
 */
export function checkGithubOrg(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "GitHub owner must be a string." };
  }
  if (value === "") {
    return { ok: false, reason: "GitHub owner must not be empty." };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: "GitHub owner must not have surrounding whitespace." };
  }
  if (!isOwnerLabel(value)) {
    return { ok: false, reason: "GitHub owner must use lowercase letters and digits with hyphens only inside." };
  }
  return { ok: true, value };
}

/**
 * Check a candidate `githubOrgs` list: a list of lowercase owner names,
 * possibly empty. A value that is not a list, or a list with any invalid
 * entry, is refused whole rather than filtered.
 */
export function checkGithubOrgs(value: unknown): StringListCheck {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "GitHub owners must be a list." };
  }
  for (const entry of value) {
    if (checkGithubOrg(entry).ok !== true) {
      return { ok: false, reason: "GitHub owners list holds an invalid owner." };
    }
  }
  return { ok: true, value: (value as string[]).slice() };
}

/**
 * Check a candidate pipeline repository of step 5: `owner/name` in lowercase,
 * the owner of letters and digits with hyphens only inside, the name of
 * letters, digits, hyphens, dots and underscores, never `.` or `..`.
 */
export function checkPipelineRepo(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "Pipeline repository must be a string." };
  }
  if (value === "") {
    return { ok: false, reason: "Pipeline repository must not be empty." };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: "Pipeline repository must not have surrounding whitespace." };
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return { ok: false, reason: "Pipeline repository must not contain control characters." };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: "Pipeline repository must not contain whitespace." };
  }
  const parts = value.split("/");
  if (parts.length !== 2) {
    return { ok: false, reason: "Pipeline repository must be owner/name." };
  }
  const owner = parts[0];
  const name = parts[1];
  if (checkGithubOrg(owner).ok !== true) {
    return { ok: false, reason: "Pipeline repository owner must use lowercase letters and digits with hyphens only inside." };
  }
  if (name === "" || name === "." || name === "..") {
    return { ok: false, reason: "Pipeline repository name must not be empty, . or .." };
  }
  if (!/^[a-z0-9._-]+$/.test(name)) {
    return { ok: false, reason: "Pipeline repository name must use lowercase letters, digits, hyphens, dots and underscores." };
  }
  return { ok: true, value };
}

/**
 * Check the ticket-number shape of provisional decision 4: 1 to 12 uppercase
 * letters followed by 1 to 20 digits.
 */
export function checkTicketNumber(value: unknown): StringCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "Ticket number must be a string." };
  }
  if (!/^[A-Z]{1,12}[0-9]{1,20}$/.test(value)) {
    return { ok: false, reason: "Ticket number must be 1 to 12 uppercase letters followed by 1 to 20 digits." };
  }
  return { ok: true, value };
}
