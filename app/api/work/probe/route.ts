import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { isSelfTarget } from "@/lib/work-probe";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * Probe the configured work dashboard address.
 *
 * A POST, not a GET, although it changes nothing: the request guard lets
 * safe methods through after checking only the host, so a GET could be
 * triggered by any page open in the browser, while a POST goes through the
 * guard's `Origin` and `Sec-Fetch-Site` checks. Viewer mode does not cover
 * `/api/work/`, so the probe stays available there.
 *
 * One `fetch` of the configured address with a two-second timeout and the
 * page's own cancellation. A redirect is never followed, so the probe never
 * connects anywhere but the validated address. Once `fetch` resolves the
 * collector is reachable, whatever the status; a network error or the
 * timeout is unreachable.
 */
export async function POST(req: Request) {
  const configured = getConfig().workDashboardUrl;
  if (!configured) {
    return NextResponse.json({ configured: false }, { headers });
  }
  if (isSelfTarget(configured, req.url, req.headers.get("host"))) {
    return NextResponse.json(
      { configured: true, reachable: false, reason: "self" },
      { headers },
    );
  }
  let reachable = false;
  try {
    const response = await fetch(configured, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(2000)]),
    });
    if (response.body !== null) {
      await response.body.cancel().catch(() => {});
    }
    reachable = true;
  } catch {
    reachable = false;
  }
  return NextResponse.json({ configured: true, reachable }, { headers });
}
