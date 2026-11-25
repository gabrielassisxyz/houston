// The chain of one bead: the work-tracker item its external reference names, the epic it sits
// under or the beads under it, and the delivery pipeline of its project's repository, each part
// carrying a state. One answer for the drawer, the epic view and the agents' route, so it is pure
// and imports other lib/ modules by a relative path only: a pure test loads it without a build.
import type { Bead } from "./schema";
import { descendantsOf, makeIndex, parentOf } from "./beads-view";
import { changeLink, pullRequestLink, runLink, ticketLink, type LinkSettings } from "./outbound-links";
import {
  lookupTicket,
  type ApprovalMatch,
  type BudgetIssueRecord,
  type Freshness,
  type PipelineRecord,
  type PrRecord,
  type RepoIssueRecord,
  type RunRecord,
  type Snapshot,
  type Source,
  type TicketSourceKey,
} from "./snapshot-format";

/** The part of a project the chain reads; `ProjectEntry` and `DemoProject` both satisfy it. */
export type ChainProject = { id: string; pipelineRepo?: string };

/** The snapshot as `lib/snapshot.ts` reads it, restated so this module stays free of `server-only`. */
export type ChainSnapshotInput = { available: true; snapshot: Snapshot } | { available: false; reason: string };

/** `lastConfirmedAt` is present only beside `historical`. */
export type Dated = { freshness: Freshness["state"]; lastConfirmedAt?: string };

export type ChainApproval = {
  number: string;
  title: string;
  recordType: string;
  state: string;
  link: string | null;
} & Dated;

export type TrackerItem =
  | ({
      state: "found";
      source: TicketSourceKey;
      number: string;
      title: string;
      status: string;
      sprint?: string;
      link: string | null;
      approvals: ChainApproval[];
    } & Dated)
  | { state: "absent"; approvals: ChainApproval[] }
  | { state: "unconfirmed"; reason: string; approvals: ChainApproval[] };

export type ChainBead = {
  id: string;
  projectId: string;
  type: string;
  status: string;
  title: string;
  externalRef?: string;
};

export type ChainDescendant = {
  id: string;
  type: string;
  status: string;
  title: string;
  externalRef?: string;
  tracker: TrackerItem | null;
};

export type ChainEpic = { id: string; status: string; title: string; externalRef?: string; tracker: TrackerItem | null };

export type ChainRun = {
  id: number;
  createdAt: string;
  status: string;
  conclusion: string | null;
  head: string | null;
  link: string | null;
  existingPrs: { number: number; link: string | null }[];
};

export type ChainPullRequest = { number: number; base: string; head: string; anomalies: string[]; link: string | null };

export type ChainIssue = { part: string; repo?: string; runId?: number; error?: string; limit?: number };

export type ChainChange = { number: string; link: string | null };

export type ChainPipeline =
  | ({
      state: "found";
      runs: ChainRun[];
      prs: ChainPullRequest[];
      issues: ChainIssue[];
      changes: ChainChange[];
    } & Dated)
  | { state: "absent" }
  | { state: "unconfirmed"; reason: string; issues?: ChainIssue[] };

export type Chain = {
  bead: ChainBead;
  tracker: TrackerItem | null;
  descendants?: ChainDescendant[];
  epic?: ChainEpic | null;
  pipeline?: ChainPipeline;
  snapshot: { available: boolean; reason?: string };
};

type IssueRecord = BudgetIssueRecord | RepoIssueRecord;

function dated(freshness: Freshness): Dated {
  if (freshness.state === "historical") return { freshness: "historical", lastConfirmedAt: freshness.at };
  return { freshness: freshness.state };
}

function externalRefOf(bead: Bead): string | undefined {
  if (typeof bead.external_ref !== "string") return undefined;
  const trimmed = bead.external_ref.trim();
  return trimmed === "" ? undefined : trimmed;
}

function withRef(externalRef: string | undefined): { externalRef?: string } {
  return externalRef === undefined ? {} : { externalRef };
}

// ------------------------------------------------------------------------------ tracker items

function chainApproval(match: ApprovalMatch, settings: LinkSettings): ChainApproval {
  const { record } = match;
  return {
    number: record.number,
    title: record.title,
    recordType: record.record_type,
    state: record.state,
    link: ticketLink(record.link, settings),
    ...dated(match.freshness),
  };
}

function ticketReason(snapshot: Snapshot, incomplete: readonly TicketSourceKey[]): string {
  const named = incomplete.map((key) => `${key} (${snapshot.tickets[key].effectiveStatus})`);
  return `ticket sources not collected ok and complete: ${named.join(", ")}`;
}

function trackerItem(externalRef: string | undefined, read: ChainSnapshotInput, settings: LinkSettings): TrackerItem | null {
  if (externalRef === undefined) return null;
  if (!read.available) return { state: "unconfirmed", reason: read.reason, approvals: [] };
  const lookup = lookupTicket(read.snapshot, externalRef);
  const approvals = lookup.approvals.map((match) => chainApproval(match, settings));
  if (lookup.result === "absent") return { state: "absent", approvals };
  if (lookup.result === "unconfirmed") {
    return { state: "unconfirmed", reason: ticketReason(read.snapshot, lookup.incompleteSources), approvals };
  }
  const { record } = lookup;
  const sprint = record.sprint !== undefined && record.sprint.trim() !== "" ? { sprint: record.sprint } : {};
  return {
    state: "found",
    ...dated(lookup.freshness),
    source: lookup.source,
    number: record.number,
    title: record.title,
    status: record.state,
    ...sprint,
    link: ticketLink(record.link, settings),
    approvals,
  };
}

// ---------------------------------------------------------------------------- the hierarchy

// The edge, never `bead.parent`: `bd` does not export that field, so a walk over it would find
// no epic for any bead of a real tracker.
function enclosingEpic(bead: Bead, index: Map<string, Bead>): Bead | null {
  const visited = new Set<string>([bead.id]);
  let current = parentOf(bead, index);
  while (current !== null && !visited.has(current.id)) {
    if (current.issue_type === "epic") return current;
    visited.add(current.id);
    current = parentOf(current, index);
  }
  return null;
}

function epicPart(epic: Bead | null, read: ChainSnapshotInput, settings: LinkSettings): ChainEpic | null {
  if (epic === null) return null;
  const externalRef = externalRefOf(epic);
  return {
    id: epic.id,
    status: epic.status,
    title: epic.title,
    ...withRef(externalRef),
    tracker: trackerItem(externalRef, read, settings),
  };
}

function descendantPart(bead: Bead, read: ChainSnapshotInput, settings: LinkSettings): ChainDescendant {
  const externalRef = externalRefOf(bead);
  return {
    id: bead.id,
    type: bead.issue_type,
    status: bead.status,
    title: bead.title,
    ...withRef(externalRef),
    tracker: trackerItem(externalRef, read, settings),
  };
}

// ----------------------------------------------------------------------------- the pipeline

function isBudgetIssue(record: IssueRecord): record is BudgetIssueRecord {
  return record.part === "budget";
}

function newestRunFirst(a: RunRecord, b: RunRecord): number {
  if (a.created_at > b.created_at) return -1;
  if (a.created_at < b.created_at) return 1;
  return b.id - a.id;
}

type RepoRecords = { runs: RunRecord[]; prs: PrRecord[]; issues: IssueRecord[] };

function recordsOfRepo(source: Source<PipelineRecord>, repo: string): RepoRecords {
  const found: RepoRecords = { runs: [], prs: [], issues: [] };
  for (const record of source.records) {
    if (record.kind === "run") {
      if (record.repo === repo) found.runs.push(record);
    } else if (record.kind === "pr") {
      if (record.repo === repo) found.prs.push(record);
    } else if (isBudgetIssue(record) || record.repo === repo) {
      found.issues.push(record);
    }
  }
  found.runs.sort(newestRunFirst);
  found.prs.sort((a, b) => b.number - a.number);
  return found;
}

function chainRun(run: RunRecord, settings: LinkSettings): ChainRun {
  return {
    id: run.id,
    createdAt: run.created_at,
    status: run.status,
    conclusion: run.conclusion,
    head: run.head,
    link: runLink(run.repo, run.id, settings),
    existingPrs: (run.existing_prs ?? []).map((number) => ({ number, link: pullRequestLink(run.repo, number, settings) })),
  };
}

function chainPullRequest(pr: PrRecord, settings: LinkSettings): ChainPullRequest {
  return {
    number: pr.number,
    base: pr.base,
    head: pr.head,
    anomalies: pr.anomalies,
    link: pullRequestLink(pr.repo, pr.number, settings),
  };
}

function chainIssue(record: IssueRecord): ChainIssue {
  if (isBudgetIssue(record)) return { part: record.part, limit: record.limit };
  const runId = record.run_id === null || record.run_id === undefined ? {} : { runId: record.run_id };
  return { part: record.part, repo: record.repo, ...runId, error: record.error };
}

function runChanges(runs: readonly RunRecord[], snapshot: Snapshot, settings: LinkSettings): ChainChange[] {
  const records = snapshot.tickets.changes.records;
  const seen = new Set<string>();
  const changes: ChainChange[] = [];
  for (const run of runs) {
    for (const raw of run.changes ?? []) {
      const number = raw.trim();
      const key = number.toLowerCase();
      if (number === "" || seen.has(key)) continue;
      seen.add(key);
      changes.push({ number, link: changeLink(number, records, settings) });
    }
  }
  return changes;
}

function nonEmptyText(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function issueClause(record: IssueRecord): string {
  if (isBudgetIssue(record)) return `the collection reached its budget limit of ${record.limit}`;
  const run = record.run_id === null || record.run_id === undefined ? "" : ` run ${record.run_id}`;
  const error = nonEmptyText(record.error);
  return `the ${record.part} collection for ${record.repo}${run} failed${error === null ? "" : `: ${error}`}`;
}

function sourceIsWhole(source: Source<PipelineRecord>): boolean {
  return source.effectiveStatus === "ok" && source.effectiveComplete;
}

// Only reached when the source is not whole or an issue is present, so never empty.
function pipelineReason(source: Source<PipelineRecord>, issues: readonly IssueRecord[]): string {
  const clauses: string[] = [];
  if (!sourceIsWhole(source)) {
    const error = nonEmptyText(source.envelope.error);
    const status = `the pipeline source's status is ${source.effectiveStatus}`;
    clauses.push(error === null ? status : `${status}: ${error}`);
  }
  for (const issue of issues) clauses.push(issueClause(issue));
  return clauses.join("; ");
}

function pipelinePart(repo: string, read: ChainSnapshotInput, settings: LinkSettings): ChainPipeline {
  if (!read.available) return { state: "unconfirmed", reason: read.reason };
  const source = read.snapshot.pipeline;
  const { runs, prs, issues } = recordsOfRepo(source, repo);
  if (runs.length > 0 || prs.length > 0) {
    return {
      state: "found",
      // An issue means part of this repository went unread, whatever the envelope says.
      ...(issues.length > 0 ? { freshness: "partial" as const } : dated(source.freshness)),
      runs: runs.map((run) => chainRun(run, settings)),
      prs: prs.map((pr) => chainPullRequest(pr, settings)),
      issues: issues.map(chainIssue),
      changes: runChanges(runs, read.snapshot, settings),
    };
  }
  if (issues.length > 0 || !sourceIsWhole(source)) {
    const shown = issues.length > 0 ? { issues: issues.map(chainIssue) } : {};
    return { state: "unconfirmed", reason: pipelineReason(source, issues), ...shown };
  }
  return { state: "absent" };
}

// ------------------------------------------------------------------------------- the chain

/**
 * Resolves the chain of `bead` among `beads`, every bead of its project. An epic carries the
 * beads under it at any depth; any other bead carries its nearest enclosing epic. The pipeline
 * part is there only when the project names a pipeline repository.
 */
export function resolveChain(
  bead: Bead,
  beads: Bead[],
  project: ChainProject,
  read: ChainSnapshotInput,
  settings: LinkSettings,
): Chain {
  const externalRef = externalRefOf(bead);
  const hierarchy =
    bead.issue_type === "epic"
      ? { descendants: descendantsOf(bead.id, beads).map((under) => descendantPart(under, read, settings)) }
      : { epic: epicPart(enclosingEpic(bead, makeIndex(beads)), read, settings) };
  const pipeline = project.pipelineRepo ? { pipeline: pipelinePart(project.pipelineRepo, read, settings) } : {};
  return {
    bead: {
      id: bead.id,
      projectId: project.id,
      type: bead.issue_type,
      status: bead.status,
      title: bead.title,
      ...withRef(externalRef),
    },
    tracker: trackerItem(externalRef, read, settings),
    ...hierarchy,
    ...pipeline,
    snapshot: read.available ? { available: true } : { available: false, reason: read.reason },
  };
}
