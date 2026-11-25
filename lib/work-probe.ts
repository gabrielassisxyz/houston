/**
 * Self-target check for the work dashboard probe.
 *
 * The hub and the collector are distinct services, so Houston never probes
 * its own address: framing Houston inside itself helps nobody. Houston's own
 * address is taken two ways, because Next may put its internal listening host
 * name in `request.url` (`app/api/viewer-mode/route.ts:17-21` meets the same
 * problem): the request URL itself, and a URL built from the request's
 * protocol and the `Host` header, so default ports and case are normalised
 * by the parser instead of compared as strings.
 *
 * The target is self when its origin equals either candidate, or when its
 * scheme and port match either candidate's while that candidate's hostname,
 * with surrounding brackets stripped, is a local alias (`127.0.0.1`,
 * `localhost`, `::1`, `0.0.0.0`, `::`). The strip matters because the parser
 * keeps the brackets of an IPv6 literal (`new URL("http://[::1]:3300/")`
 * `.hostname` is `"[::1]"`, checked on Node v24.18.0), so without it neither
 * IPv6 alias ever matches. This closes the gap of a server opened on
 * `localhost` or `[::1]`, or listening on `0.0.0.0` or `::`.
 *
 * Kept free of imports so scripts/test-work-probe.mjs can load it directly,
 * like lib/request-guard.ts.
 */

/** Host names that mean "this machine" for the self-target check. */
const LOCAL_ALIASES = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);

function stripBrackets(name: string): string {
  return name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

/**
 * Whether the configured dashboard `target` names Houston's own server, seen
 * either through `requestUrl` or through the `Host` header (`null` or
 * missing when the client sent none). Never throws: an unparsable target,
 * request URL or `Host` header simply does not match.
 */
export function isSelfTarget(
  target: string,
  requestUrl: string,
  hostHeader: string | null | undefined,
): boolean {
  let parsedTarget: URL;
  let parsedRequest: URL;
  try {
    parsedTarget = new URL(target);
    parsedRequest = new URL(requestUrl);
  } catch {
    return false;
  }
  const candidates: URL[] = [parsedRequest];
  if (hostHeader) {
    try {
      candidates.push(new URL(`${parsedRequest.protocol}//${hostHeader}`));
    } catch {
      // A malformed Host never matches; the request-URL candidate still counts.
    }
  }
  for (const candidate of candidates) {
    if (parsedTarget.origin === candidate.origin) return true;
    if (
      parsedTarget.protocol === candidate.protocol &&
      parsedTarget.port === candidate.port &&
      LOCAL_ALIASES.has(stripBrackets(candidate.hostname.toLowerCase()))
    ) {
      return true;
    }
  }
  return false;
}
