import { ok } from "@/lib/api";
import { sprintStore } from "@/lib/sprints";
import { sprintRouteFailure } from "@/lib/sprint-http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ sprints: await sprintStore.list() });
  } catch (e) {
    return sprintRouteFailure(e);
  }
}

export async function POST(req: Request) {
  try {
    return ok(await sprintStore.create(await req.json()), 201);
  } catch (e) {
    return sprintRouteFailure(e);
  }
}
