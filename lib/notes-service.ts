import "server-only";
import { z } from "zod";
import { getConfig } from "./config";
import { isSelfTarget } from "./work-probe";

/**
 * The hub's only way to the notes service. Pages never call the service: every
 * call goes through this module on the server, and every way it can go wrong
 * becomes an answer rather than a thrown error, so a stopped or wrong service
 * degrades one part of a page instead of breaking or hanging it.
 */

const TIMEOUT_MS = 2000;

const kindSchema = z.enum(["plano", "implementacao", "evidencia", "nota"]);

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  kind: kindSchema,
  tags: z.array(z.string()),
});

const countSchema = z.number().int().nonnegative();

// The shapes the notes service pins. Fields it may add later are dropped; a
// missing or differently typed one makes the whole answer unusable.
const refsSchema = z.object({
  notes: z.array(noteSchema.extend({ matchedRefs: z.array(z.string()) })),
  linked: z.array(noteSchema),
  linkedOmitted: countSchema,
});

const searchSchema = z.object({
  hits: z.array(noteSchema.extend({ snippet: z.string() })),
  total: countSchema,
  limit: countSchema,
  offset: countSchema,
});

export type NoteKind = z.infer<typeof kindSchema>;
export type NotesRefsAnswer = z.infer<typeof refsSchema>;
export type NotesSearchAnswer = z.infer<typeof searchSchema>;

export type NotesResult<T> =
  | { ok: true; answer: T }
  /** `unconfigured`: no address is set. `unavailable`: one is, but gave nothing usable. */
  | { ok: false; status: "unconfigured" | "unavailable"; reason: string };

export type NotesRefsQuery = {
  /** Sent as one comma-separated list, so an identifier must not hold a comma. */
  ids: readonly string[];
  kind?: NoteKind;
  hop?: 0 | 1;
};

export type NotesSearchQuery = {
  q: string;
  tag?: string;
  folder?: string;
  kind?: NoteKind;
  limit?: number;
  offset?: number;
};

type QueryParams = Record<string, string | number | undefined>;

/** The notes that cite any of the identifiers, and with `hop: 1` their neighbours. */
export function fetchNotesRefs(request: Request, query: NotesRefsQuery): Promise<NotesResult<NotesRefsAnswer>> {
  const { ids, kind, hop } = query;
  return callNotesService(request, "/api/notes/refs", { ids: ids.join(","), kind, hop }, refsSchema);
}

/** One page of the ranked search. */
export function searchNotes(request: Request, query: NotesSearchQuery): Promise<NotesResult<NotesSearchAnswer>> {
  // Named one by one so a caller's extra properties never reach the service.
  const { q, tag, folder, kind, limit, offset } = query;
  return callNotesService(request, "/api/search", { q, tag, folder, kind, limit, offset }, searchSchema);
}

function unavailable(reason: string): NotesResult<never> {
  return { ok: false, status: "unavailable", reason };
}

/** One GET of the configured service, its answer checked against `schema`. */
async function callNotesService<T>(
  request: Request,
  path: string,
  params: QueryParams,
  schema: z.ZodType<T>,
): Promise<NotesResult<T>> {
  const base = getConfig().notesServiceUrl;
  if (!base) {
    return { ok: false, status: "unconfigured", reason: "The notes service URL is not set." };
  }
  // The incoming request is what names Houston's own address.
  if (isSelfTarget(base, request.url, request.headers.get("host"))) {
    return unavailable("The notes service URL points at Houston itself.");
  }
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const read = await readText(request, url);
  if (!read.ok) return read;
  let body: unknown;
  try {
    body = JSON.parse(read.answer);
  } catch {
    return unavailable("The notes service did not answer JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unavailable("The notes service answered an unexpected shape.");
  }
  return { ok: true, answer: parsed.data };
}

/**
 * The body of a successful answer. The timeout and the incoming request's
 * cancellation cover the body too, not only the headers.
 */
async function readText(request: Request, url: URL): Promise<NotesResult<string>> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    // A redirect is never followed: it would leave the validated address.
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unavailable(`The notes service answered HTTP ${response.status}.`);
    }
    return { ok: true, answer: await response.text() };
  } catch {
    if (request.signal.aborted) return unavailable("The request was cancelled before the notes service answered.");
    if (timeout.aborted) return unavailable("The notes service did not answer in time.");
    return unavailable("The notes service could not be reached.");
  }
}
