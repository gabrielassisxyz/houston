/**
 * Obsidian link builder.
 *
 * Builds the address a note opens with in Obsidian,
 * `obsidian://open?vault=<vault>&file=<path>`, with both values encoded by
 * `encodeURIComponent` (never `encodeURI`, which leaves `#`, `&`, `+` and `?`
 * unencoded, nor `URLSearchParams`, which turns spaces into `+`). Answers
 * `null` when the vault is unset or the path is empty, in which case the path
 * is shown as plain text and the link carries no `target`, so no empty tab is
 * left behind once Obsidian takes the address.
 *
 * Kept free of imports so scripts can load it directly, like
 * `lib/loopback-url.ts`.
 */

/**
 * Build the Obsidian open address for `path` in `vault`, or `null` when the
 * vault is unset (null, undefined, or blank) or the path is empty.
 */
export function obsidianLink(
  vault: string | null | undefined,
  path: string | null | undefined,
): string | null {
  if (typeof vault !== "string" || vault.trim() === "") return null;
  if (typeof path !== "string" || path === "") return null;
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}
