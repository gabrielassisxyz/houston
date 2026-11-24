import { ok } from "@/lib/api";
import { sprintStore } from "@/lib/sprints";
import { sprintRouteFailure } from "@/lib/sprint-http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return ok(await sprintStore.get(id));
  } catch (e) {
    return sprintRouteFailure(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return ok(await sprintStore.patch(id, await req.json()));
  } catch (e) {
    return sprintRouteFailure(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await sprintStore.remove(id);
    return ok({ removed: id });
  } catch (e) {
    return sprintRouteFailure(e);
  }
}
