import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getConfig, getProject } from "@/lib/config";
import { readSnapshot } from "@/lib/snapshot";
import {
  collectChainRefIds,
  mergeNotesAnswers,
  NOTES_BATCH_SIZE,
  resolveChain,
  type ChainNotes,
  type ChainNotesInput,
} from "@/lib/chain";
import { fetchNotesRefs } from "@/lib/notes-service";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ projectId: string; id: string }> };

/** The chain of one bead: its tracker item, its epic or descendants, and its pipeline. */
export async function GET(req: Request, { params }: Ctx) {
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

    // Notes, in batches of 200 with hop=1: the refs route splits its `ids`
    // list on commas and refuses more than 200. After the first unavailable
    // answer the rest of the request makes no further notes call.
    const refIds = collectChainRefIds(bead, beads);
    let notesInput: ChainNotesInput | undefined;
    let notesUnavailable: { reason: string } | null = null;
    let notesConfigured = true;
    if (refIds.length > 0) {
      const batches: ChainNotesInput[] = [];
      for (let at = 0; at < refIds.length; at += NOTES_BATCH_SIZE) {
        const batch = refIds.slice(at, at + NOTES_BATCH_SIZE);
        const result = await fetchNotesRefs(req, { ids: batch, hop: 1 });
        if (!result.ok) {
          if (result.status === "unconfigured") {
            notesConfigured = false;
          } else {
            notesUnavailable = { reason: result.reason };
          }
          break;
        }
        batches.push(result.answer);
      }
      if (batches.length > 0) {
        notesInput = mergeNotesAnswers(batches);
      }
    }

    const chain = resolveChain(
      bead,
      beads,
      { id: projectId, ...pipelineRepo },
      read,
      { serviceNowHost: cfg.serviceNowHost ?? null, githubOrgs: cfg.githubOrgs ?? null },
      notesInput,
    );
    let notes: ChainNotes | undefined = chain.notes;
    if (!notesConfigured) {
      notes = undefined;
    } else if (notesUnavailable) {
      notes = { state: "unavailable", reason: notesUnavailable.reason };
    }
    // An absent notes part is omitted, never null: with the service
    // unconfigured the chain carries no `notes` key at all.
    if (notes === undefined) {
      const body = { ...chain };
      delete body.notes;
      return NextResponse.json(body, { headers });
    }
    return NextResponse.json({ ...chain, notes }, { headers });
  } catch (e) {
    const res = fail(e);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
