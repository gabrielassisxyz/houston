import { NextResponse } from "next/server";
import { searchNotes, type NotesSearchQuery } from "@/lib/notes-service";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

const KINDS = new Set(["plano", "implementacao", "evidencia", "nota"]);

function invalid(reason: string) {
  return NextResponse.json(
    { error: reason, code: "invalid_search" },
    { status: 400, headers },
  );
}

/**
 * Read-only proxy to the notes service's ranked search. Viewer mode leaves
 * it alone: like every GET, it reads nothing that a viewer may not read.
 *
 * Only `q`, `tag`, `folder`, `kind`, `limit` and `offset` are forwarded. The
 * address rules of the service (A9) are checked here, because the hub's
 * notes client turns every non-2xx answer into `unavailable` and a bad
 * address would otherwise read as a stopped service: a 400 from here is an
 * invalid search, while a 503 carries `unconfigured` or `unavailable` apart
 * from zero hits.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const rawQ = params.get("q");
  if (rawQ === null || rawQ.trim() === "") {
    return invalid("A busca precisa de um termo.");
  }
  const rawKind = params.get("kind");
  if (rawKind !== null && !KINDS.has(rawKind)) {
    return invalid("Tipo de nota desconhecido.");
  }
  const rawLimit = params.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^-?\d+$/.test(rawLimit)) {
      return invalid("O limite precisa ser um número inteiro.");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return invalid("O limite precisa ser ao menos 1.");
    }
  }
  const rawOffset = params.get("offset");
  let offset: number | undefined;
  if (rawOffset !== null) {
    if (!/^-?\d+$/.test(rawOffset)) {
      return invalid("O deslocamento precisa ser um número inteiro.");
    }
    offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return invalid("O deslocamento não pode ser negativo.");
    }
  }
  const rawTag = params.get("tag");
  const rawFolder = params.get("folder");
  const query: NotesSearchQuery = { q: rawQ };
  if (rawTag !== null && rawTag !== "") query.tag = rawTag;
  if (rawFolder !== null && rawFolder !== "") query.folder = rawFolder;
  if (rawKind !== null) query.kind = rawKind as NotesSearchQuery["kind"];
  if (limit !== undefined) query.limit = limit;
  if (offset !== undefined) query.offset = offset;

  const result = await searchNotes(req, query);
  if (!result.ok) {
    return NextResponse.json(
      { status: result.status, reason: result.reason },
      { status: 503, headers },
    );
  }
  return NextResponse.json(result.answer, { headers });
}
