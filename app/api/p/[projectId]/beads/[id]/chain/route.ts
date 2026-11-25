import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getConfig, getProject } from "@/lib/config";
import { readSnapshot } from "@/lib/snapshot";
import { resolveChain } from "@/lib/chain";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ projectId: string; id: string }> };

/** The chain of one bead: its tracker item, its epic or descendants, and its pipeline. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const bead = await store.get(id);
    if (!bead) {
      return NextResponse.json({ error: "not found", code: "not_found" }, { status: 404, headers });
    }
    const beads = await store.list();
    const read = readSnapshot();
    const cfg = getConfig();
    const entry = getProject(projectId);
    const pipelineRepo =
      entry && "pipelineRepo" in entry && entry.pipelineRepo ? { pipelineRepo: entry.pipelineRepo } : {};
    const chain = resolveChain(
      bead,
      beads,
      { id: projectId, ...pipelineRepo },
      read,
      { serviceNowHost: cfg.serviceNowHost ?? null, githubOrgs: cfg.githubOrgs ?? null },
    );
    return NextResponse.json(chain, { headers });
  } catch (e) {
    const res = fail(e);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
