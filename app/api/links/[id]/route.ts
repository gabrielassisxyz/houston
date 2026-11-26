import { NextResponse } from "next/server";
import { getConfig, listProjects } from "@/lib/config";
import { readSnapshot } from "@/lib/snapshot";
import { readProjects } from "@/lib/all-projects";
import {
  collectChainRefIds,
  groupNotesAnswer,
  mergeNotesAnswers,
  NOTES_BATCH_SIZE,
  resolveChain,
  type ChainNotes,
  type ChainNotesInput,
} from "@/lib/chain";
import { fetchNotesRefs } from "@/lib/notes-service";
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
export async function GET(req: Request, { params }: Ctx) {
  const { id: raw } = await params;
  const id = raw.trim();
  // As a reference is (step 1): trimmed, at most 128 characters, non-blank
  // and free of ASCII control characters.
  if (id === "" || id.length > 128 || /[\u0000-\u001f]/.test(raw)) {
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

  // Notes, with hop=1 in batches of 200: after the first unavailable answer
  // the rest of the request makes no further notes call, and every remaining
  // part reads unavailable with that reason. Unconfigured reads as absent.
  let notesStopped: string | null = null;
  let notesUnconfigured = false;

  async function loadNotesInput(ids: readonly string[]): Promise<ChainNotesInput | null> {
    if (notesUnconfigured || notesStopped !== null) return null;
    if (ids.length === 0) return null;
    const batches: ChainNotesInput[] = [];
    for (let at = 0; at < ids.length; at += NOTES_BATCH_SIZE) {
      const batch = ids.slice(at, at + NOTES_BATCH_SIZE);
      const result = await fetchNotesRefs(req, { ids: batch, hop: 1 });
      if (!result.ok) {
        if (result.status === "unconfigured") {
          notesUnconfigured = true;
        } else {
          notesStopped = result.reason;
        }
        return null;
      }
      batches.push(result.answer);
    }
    if (batches.length === 0) return null;
    return mergeNotesAnswers(batches);
  }

  function toNotesPart(input: ChainNotesInput | null): ChainNotes | undefined {
    if (input !== null) {
      return { state: "available", ...groupNotesAnswer(input) };
    }
    if (notesStopped !== null) {
      return { state: "unavailable", reason: notesStopped };
    }
    return undefined;
  }

  // The top-level notes for the identifier itself, so an identifier no bead
  // carries still returns its notes. An identifier holding a comma is left
  // out, because the refs route would split it.
  const topIds = id.includes(",") ? [] : [id];
  const topInput = await loadNotesInput(topIds);
  const topNotes = toNotesPart(topInput);

  const needle = id.toLowerCase();
  const { reads, failed } = await readProjects(listProjects());
  const beads = [];
  for (const { project, beads: local } of reads) {
    const entry = { id: project.id, ...(project.pipelineRepo ? { pipelineRepo: project.pipelineRepo } : {}) };
    for (const bead of local) {
      const sameId = bead.id.trim().toLowerCase() === needle;
      const ref = typeof bead.external_ref === "string" ? bead.external_ref.trim().toLowerCase() : "";
      if (!sameId && ref !== needle) continue;
      const refIds = collectChainRefIds(bead, local);
      const input = await loadNotesInput(refIds);
      const chain = resolveChain(bead, local, entry, read, settings, input ?? undefined);
      const notes = toNotesPart(input);
      if (notes === undefined) {
        const without = { ...chain };
        delete without.notes;
        beads.push({ projectId: project.id, projectName: project.name, chain: without });
      } else {
        beads.push({ projectId: project.id, projectName: project.name, chain: { ...chain, notes } });
      }
    }
  }
  const unreadable = failed.map(({ id: failedId, name, error }) => ({ id: failedId, name, error }));
  if (topNotes === undefined) {
    return NextResponse.json({ id, snapshot, ticket, beads, unreadable }, { headers });
  }
  return NextResponse.json({ id, snapshot, ticket, beads, unreadable, notes: topNotes }, { headers });
}
