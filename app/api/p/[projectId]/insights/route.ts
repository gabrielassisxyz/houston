import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { projectEvents } from "@/lib/events";
import { computeInsights } from "@/lib/insights";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const url = new URL(req.url);
    const days = Math.min(365, Math.max(7, Number(url.searchParams.get("days")) || 30));

    const store = await getStore(projectId);
    const cfg = getConfig();
    const beads = await store.list();
    const events = await projectEvents(projectId, beads);

    const data = computeInsights(beads, events, cfg.humanAllowlist, days, Date.now());
    return ok(data);
  } catch (e) {
    return fail(e);
  }
}
