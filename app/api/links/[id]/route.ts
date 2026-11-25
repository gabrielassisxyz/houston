import { NextResponse } from "next/server";
import { getConfig, listProjects } from "@/lib/config";
import { readSnapshot } from "@/lib/snapshot";
import { readProjects } from "@/lib/all-projects";
import { resolveChain } from "@/lib/chain";
import type { Bead } from "@/lib/schema";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

/**
 * The links of one identifier across every registered project: the ticket it
 * names and every bead that carries it, each with its chain. One `readSnapshot()`
 * per request is passed to the ticket lookup and to every chain, so a rewrite
 * during the request never splits one answer across two snapshots.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id: raw } = await params;
  const id = raw.trim();
  // As a reference is (step 1): trimmed, at most 128 characters, non-blank
  // and free of ASCII control characters.
  if (id === "" || id.length > 128 || /[\u0000-\u001f\u007f]/.test(raw)) {
    return NextResponse.json({ error: "Invalid identifier", code: "invalid_input" }, { status: 400, headers });
  }
  const read = readSnapshot();
  const snapshot = read.available ? { available: true as const } : { available: false as const, reason: read.reason };
  const cfg = getConfig();
  const settings = { serviceNowHost: cfg.serviceNowHost ?? null, githubOrgs: cfg.githubOrgs ?? null };
  // The identifier itself as a tracker item: the same lookup the chain runs
  // for a bead's external reference, so the ticket never drifts from it. Only
  // the fields the resolver reads are set, hence the cast through unknown.
  const probe = { id: "__links__", title: "", status: "open", issue_type: "task", external_ref: id, dependencies: [] } as unknown as Bead;
  const ticket = resolveChain(probe, [], { id: "__links__" }, read, settings).tracker;
  const needle = id.toLowerCase();
  const { reads, failed } = await readProjects(listProjects());
  const beads = [];
  for (const { project, beads: local } of reads) {
    const entry = { id: project.id, ...(project.pipelineRepo ? { pipelineRepo: project.pipelineRepo } : {}) };
    for (const bead of local) {
      const sameId = bead.id.trim().toLowerCase() === needle;
      const ref = typeof bead.external_ref === "string" ? bead.external_ref.trim().toLowerCase() : "";
      if (!sameId && ref !== needle) continue;
      const chain = resolveChain(bead, local, entry, read, settings);
      beads.push({ projectId: project.id, projectName: project.name, chain });
    }
  }
  const unreadable = failed.map(({ id: failedId, name, error }) => ({ id: failedId, name, error }));
  return NextResponse.json({ id, snapshot, ticket, beads, unreadable }, { headers });
}
