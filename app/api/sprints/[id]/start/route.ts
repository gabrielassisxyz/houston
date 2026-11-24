import { ok } from "@/lib/api";
import { realSprintRunDeps, startSprint } from "@/lib/sprint-run";
import { sprintRouteFailure } from "@/lib/sprint-http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return ok(await startSprint(id, realSprintRunDeps()));
  } catch (e) {
    return sprintRouteFailure(e);
  }
}
