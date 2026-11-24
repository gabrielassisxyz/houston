import { NextResponse } from "next/server";
import { ok } from "@/lib/api";
import { closeSprint, realSprintRunDeps } from "@/lib/sprint-run";
import { sprintRouteFailure } from "@/lib/sprint-http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { sprint, remaining } = await closeSprint(id, realSprintRunDeps());
    if (remaining.length === 0) return ok(sprint);
    // The summary is stored and the sprint is `closing`: asking again retries only these.
    return NextResponse.json(
      {
        error: `Sprint ${id} is not closed: ${remaining.length} bead(s) still carry its label`,
        code: "close_incomplete",
        remaining,
        sprint,
      },
      { status: 500 },
    );
  } catch (e) {
    return sprintRouteFailure(e);
  }
}
