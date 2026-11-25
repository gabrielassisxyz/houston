// Format version 1 of the snapshot file a local collector writes on the work machine: the part
// of it Houston reads, validated, and the one lookup of a ticket number across its ticket
// sources. Pure on purpose (no `server-only`, no local import), so a test loads it without a
// build and the browser could share its types.
import { z } from "zod";

/** The ticket sources, in the order a lookup searches them. */
export const TICKET_SOURCES = [
  "incidents",
  "changes",
  "work_tracker_stories",
  "work_tracker_bugs",
  "work_tracker_tasks",
  "work_tracker_subtasks",
  "ritms",
] as const;
export type TicketSourceKey = (typeof TICKET_SOURCES)[number];

const TRACKER_LISTS: readonly TicketSourceKey[] = [
  "work_tracker_stories",
  "work_tracker_bugs",
  "work_tracker_tasks",
  "work_tracker_subtasks",
];

export const SOURCE_STATUSES = ["not_collected", "ok", "partial", "error", "auth_expired"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

// zod 4 refuses an unsafe integer here, so 2**53 is refused as well.
const positiveInt = z.number().int().positive();
// A key the shape forbids: absent passes, any value (null included) is refused.
const forbidden = z.never().optional();

const envelopeSchema = z.object({
  label: z.string(),
  provider: z.string().nullable(),
  status: z.enum(SOURCE_STATUSES),
  complete: z.boolean(),
  last_attempt_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  error: z.string().nullable(),
  // Only a list here: each record is parsed on its own, so one bad record never fails the envelope.
  records: z.array(z.unknown()),
});

const ticketFields = {
  key: z.string(),
  number: z.string(),
  title: z.string(),
  state: z.string(),
  link: z.string(),
};
const ticketRecordSchema = z.object(ticketFields);
const trackerRecordSchema = z.object({ ...ticketFields, sprint: z.string().optional() });

const approvalRecordSchema = z.object({
  key: z.string(),
  number: z.string(),
  title: z.string(),
  state: z.string(),
  link: z.string(),
  record_type: z.string(),
});

const runRecordSchema = z.object({
  kind: z.literal("run"),
  key: z.string(),
  id: positiveInt,
  repo: z.string(),
  created_at: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head: z.string().nullable(),
  changes: z.array(z.string()).optional(),
  existing_prs: z.array(positiveInt).optional(),
});

const prRecordSchema = z.object({
  kind: z.literal("pr"),
  key: z.string(),
  number: positiveInt,
  repo: z.string(),
  base: z.string(),
  head: z.string(),
  anomalies: z.array(z.string()),
});

const budgetIssueSchema = z.object({
  kind: z.literal("issue"),
  key: z.string(),
  part: z.literal("budget"),
  limit: positiveInt,
  repo: forbidden,
  run_id: forbidden,
});

// Any part but "budget", so a repository issue that lost its `repo` is refused rather than
// read as the budget issue.
const repoIssueSchema = z.object({
  kind: z.literal("issue"),
  key: z.string(),
  part: z.string().min(1).refine((part) => part !== "budget"),
  repo: z.string(),
  error: z.string(),
  run_id: positiveInt.nullable().optional(),
  limit: forbidden,
});

const pipelineRecordSchema = z.union([runRecordSchema, prRecordSchema, budgetIssueSchema, repoIssueSchema]);

export type SourceEnvelope = Omit<z.infer<typeof envelopeSchema>, "records">;
export type TicketRecord = z.infer<typeof trackerRecordSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type PrRecord = z.infer<typeof prRecordSchema>;
export type BudgetIssueRecord = z.infer<typeof budgetIssueSchema>;
export type RepoIssueRecord = z.infer<typeof repoIssueSchema>;
export type PipelineRecord = z.infer<typeof pipelineRecordSchema>;

/** How far a source's records can be trusted, read from its envelope first. */
export type Freshness = { state: "confirmed" } | { state: "historical"; at: string } | { state: "partial" };

export interface Source<R> {
  key: string;
  /** The envelope as the file states it, or the fallback for an absent or malformed one. */
  envelope: SourceEnvelope;
  records: R[];
  /** Records left out because they failed validation. */
  dropped: number;
  /** `partial` where the file says `ok` of a source that is not wholly read. */
  effectiveStatus: SourceStatus;
  /** False where the file says false or a record was dropped. */
  effectiveComplete: boolean;
  freshness: Freshness;
}

export interface Snapshot {
  tickets: Record<TicketSourceKey, Source<TicketRecord>>;
  approvals: Source<ApprovalRecord>;
  pipeline: Source<PipelineRecord>;
}

export type SnapshotParse = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):([0-5]\d))$/;

/**
 * True for `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` naming a day that exists. `Date.parse`
 * alone accepts `"1"` and rolls `2026-02-31` over to 3 March.
 */
export function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function freshnessOf(envelope: SourceEnvelope, dropped: number, effectiveStatus: SourceStatus, effectiveComplete: boolean): Freshness {
  if (effectiveStatus === "ok" && effectiveComplete) return { state: "confirmed" };
  // A source that kept its old records after a failure shows no trace of the failure in them,
  // so a time is shown only when every record it holds was read.
  if (dropped === 0 && envelope.last_success_at !== null && isIsoDateTime(envelope.last_success_at)) {
    return { state: "historical", at: envelope.last_success_at };
  }
  return { state: "partial" };
}

function absentEnvelope(key: string): SourceEnvelope {
  return {
    label: key,
    provider: null,
    status: "not_collected",
    complete: false,
    last_attempt_at: null,
    last_success_at: null,
    error: null,
  };
}

/** Stands in for a malformed envelope; its `error` keeps a reason built from it non-empty. */
function invalidEnvelope(key: string): SourceEnvelope {
  return { ...absentEnvelope(key), status: "error", error: "invalid envelope" };
}

function buildSource<R>(key: string, envelope: SourceEnvelope, records: R[], dropped: number): Source<R> {
  const effectiveComplete = envelope.complete && dropped === 0;
  const effectiveStatus = envelope.status === "ok" && !effectiveComplete ? "partial" : envelope.status;
  return {
    key,
    envelope,
    records,
    dropped,
    effectiveStatus,
    effectiveComplete,
    freshness: freshnessOf(envelope, dropped, effectiveStatus, effectiveComplete),
  };
}

function readSource<R>(sources: Record<string, unknown>, key: string, recordSchema: z.ZodType<R>): Source<R> {
  if (!Object.prototype.hasOwnProperty.call(sources, key)) {
    return buildSource<R>(key, absentEnvelope(key), [], 0);
  }
  const parsed = envelopeSchema.safeParse(sources[key]);
  if (!parsed.success) return buildSource<R>(key, invalidEnvelope(key), [], 0);
  const { records: rawRecords, ...envelope } = parsed.data;
  const records: R[] = [];
  let dropped = 0;
  for (const raw of rawRecords) {
    const record = recordSchema.safeParse(raw);
    if (record.success) records.push(record.data);
    else dropped += 1;
  }
  return buildSource(key, envelope, records, dropped);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an already-parsed document. Everything but the nine sources read here is ignored. */
export function readSnapshotDocument(document: unknown): SnapshotParse {
  if (!isPlainObject(document)) return { ok: false, reason: "the snapshot is not a JSON object" };
  if (document.schema_version !== 1) return { ok: false, reason: "the snapshot's schema_version is not 1" };
  const sources = document.sources;
  if (!isPlainObject(sources)) return { ok: false, reason: "the snapshot's sources is not an object" };
  const tickets = {} as Record<TicketSourceKey, Source<TicketRecord>>;
  for (const key of TICKET_SOURCES) {
    tickets[key] = readSource<TicketRecord>(sources, key, TRACKER_LISTS.includes(key) ? trackerRecordSchema : ticketRecordSchema);
  }
  return {
    ok: true,
    snapshot: {
      tickets,
      approvals: readSource(sources, "approvals", approvalRecordSchema),
      pipeline: readSource(sources, "pipeline", pipelineRecordSchema),
    },
  };
}

/** Parses the text of a snapshot file. */
export function parseSnapshot(text: string): SnapshotParse {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the snapshot is not valid JSON" };
  }
  return readSnapshotDocument(document);
}

export interface ApprovalMatch {
  record: ApprovalRecord;
  freshness: Freshness;
}

export type TicketLookup =
  | {
      result: "found";
      record: TicketRecord;
      source: TicketSourceKey;
      freshness: Freshness;
      approvals: ApprovalMatch[];
    }
  | { result: "absent"; approvals: ApprovalMatch[] }
  | {
      result: "unconfirmed";
      /** The ticket sources not collected `ok` and complete, in search order. */
      incompleteSources: TicketSourceKey[];
      approvals: ApprovalMatch[];
    };

function sameNumber(number: string, needle: string): boolean {
  return number.trim().toLowerCase() === needle;
}

/**
 * Looks a ticket number up across the ticket sources. A miss is `absent` only when every ticket
 * source was collected `ok` and complete; otherwise the number may sit in what was not read, so
 * the answer is `unconfirmed`. Approvals of the number come with every answer and never make
 * one `found`: an approval is not the primary record of the ticket it refers to.
 */
export function lookupTicket(snapshot: Snapshot, identifier: string): TicketLookup {
  const needle = identifier.trim().toLowerCase();
  const approvals: ApprovalMatch[] =
    needle === ""
      ? []
      : snapshot.approvals.records
          .filter((record) => sameNumber(record.number, needle))
          .map((record) => ({ record, freshness: snapshot.approvals.freshness }));
  if (needle !== "") {
    for (const key of TICKET_SOURCES) {
      const source = snapshot.tickets[key];
      const record = source.records.find((candidate) => sameNumber(candidate.number, needle));
      if (record) return { result: "found", record, source: key, freshness: source.freshness, approvals };
    }
  }
  const incompleteSources = TICKET_SOURCES.filter((key) => {
    const source = snapshot.tickets[key];
    return !(source.effectiveStatus === "ok" && source.effectiveComplete);
  });
  if (incompleteSources.length === 0) return { result: "absent", approvals };
  return { result: "unconfirmed", incompleteSources, approvals };
}
