import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { projectEvents } from "@/lib/events";
import { computeGamification } from "@/lib/gamification";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const beads = await store.list();
    const events = await projectEvents(projectId, beads);

    const data = computeGamification(beads, events, cfg.humanAllowlist, cfg.humanActor, Date.now());
    return ok(data);
  } catch (e) {
    return fail(e);
  }
}
