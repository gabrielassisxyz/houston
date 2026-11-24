import "server-only";
import { getConfig, listProjects } from "./config";
import { readAllProjects } from "./all-projects";
import type { AllProjectsRead } from "./all-projects";
import { getStore } from "./store";
import { SprintError, sprintStore } from "./sprints";
import { pointsOf, sizeOf, sprintLabel } from "./sprint-model";
import type { BeadRef, Sprint, SprintSummary } from "./sprint-model";

/** What start and close depend on. The routes pass the real ones; a test passes fakes. */
export interface SprintRunDeps {
  readAll: () => Promise<Pick<AllProjectsRead, "beads" | "failed">>;
  removeLabel: (projectId: string, beadId: string, label: string) => Promise<void>;
  store: {
    list: () => Promise<Sprint[]>;
    get: (id: string) => Promise<Sprint>;
    mutate: (id: string, fn: (sprint: Sprint, all: readonly Sprint[]) => Sprint) => Promise<Sprint>;
  };
  now: () => Date;
}

/** A bead the label pass could not handle, with the tracker's own message. */
export type Remaining = BeadRef & { message: string };

export function realSprintRunDeps(): SprintRunDeps {
  return {
    readAll: () => readAllProjects(listProjects()),
    removeLabel: async (projectId, beadId, label) => {
      const store = await getStore(projectId);
      await store.editLabels(beadId, { add: [], remove: [label] }, getConfig().humanActor);
    },
    store: sprintStore,
    now: () => new Date(),
  };
}

// A bead is identified by its project together with its own id: two trackers can both hold
// a bead with the same id.
function keyOf(projectId: string, id: string): string {
  return JSON.stringify([projectId, id]);
}

type Read = Awaited<ReturnType<SprintRunDeps["readAll"]>>;

function membersOf(read: Read, sprintId: string): BeadRef[] {
  const label = sprintLabel(sprintId);
  return read.beads
    .filter((b) => (b.labels ?? []).includes(label))
    .map((b) => ({
      projectId: b.project.id,
      projectName: b.project.name,
      id: b.local_id,
      title: b.title,
      size: sizeOf(b.labels ?? []),
      points: pointsOf(b.labels ?? []),
    }));
}

// One sprint runs at a time.
function refuseIfAnotherRuns(all: readonly Sprint[], id: string): void {
  const running = all.find((s) => s.id !== id && (s.state === "active" || s.state === "closing"));
  if (!running) return;
  throw new SprintError(
    "another_sprint_running",
    409,
    `Sprint ${running.id} (${running.name}) is ${running.state}; close it before starting another`,
  );
}

export async function startSprint(id: string, deps: SprintRunDeps): Promise<Sprint> {
  const sprint = await deps.store.get(id);
  if (sprint.state !== "planned") {
    throw new SprintError("sprint_not_planned", 409, `Sprint ${id} is ${sprint.state}; only a planned sprint can start`);
  }
  // Refused here to spare the read of every project, and again below at the moment the record
  // changes: that read takes long enough for a second sprint to be started meanwhile.
  refuseIfAnotherRuns(await deps.store.list(), id);
  const read = await deps.readAll();
  const members = membersOf(read, id);
  if (members.length === 0) {
    throw new SprintError("sprint_empty", 409, `No bead carries the label ${sprintLabel(id)}; add beads before starting`);
  }
  const startedAt = deps.now().toISOString();
  const unreadableAtStart = read.failed.map((f) => f.name);
  return deps.store.mutate(id, (current, all) => {
    if (current.state !== "planned") {
      throw new SprintError("sprint_not_planned", 409, `Sprint ${id} is ${current.state}; only a planned sprint can start`);
    }
    refuseIfAnotherRuns(all, id);
    return { ...current, state: "active", startedAt, planned: members, unreadableAtStart };
  });
}

function summarise(planned: BeadRef[], members: BeadRef[], doneKeys: Set<string>, unreadable: string[]): SprintSummary {
  const plannedKeys = new Set(planned.map((p) => keyOf(p.projectId, p.id)));
  const memberKeys = new Set(members.map((m) => keyOf(m.projectId, m.id)));
  return {
    plannedCount: planned.length,
    plannedPoints: planned.reduce((sum, p) => sum + p.points, 0),
    done: members.filter((m) => doneKeys.has(keyOf(m.projectId, m.id))),
    spillover: members.filter((m) => !doneKeys.has(keyOf(m.projectId, m.id))),
    added: members.filter((m) => !plannedKeys.has(keyOf(m.projectId, m.id))),
    removed: planned.filter((p) => !memberKeys.has(keyOf(p.projectId, p.id))),
    unreadable,
  };
}

// Decided once, at the first close: what was done and what spills over. The record goes to
// disk with the state `closing` before any label is touched, so a pass that dies halfway
// still leaves the list of what is left.
async function recordSummary(sprint: Sprint, deps: SprintRunDeps): Promise<Sprint> {
  const read = await deps.readAll();
  const planned = sprint.planned ?? [];
  const failedIds = new Set(read.failed.map((f) => f.id));
  const blocking = [...new Set(planned.filter((p) => failedIds.has(p.projectId)).map((p) => p.projectName))];
  if (blocking.length > 0) {
    throw new SprintError(
      "projects_unreadable",
      409,
      `Cannot close sprint ${sprint.id}: ${blocking.join(", ")} could not be read and hold planned beads`,
    );
  }
  const closed = new Set(
    read.beads.filter((b) => b.status === "closed").map((b) => keyOf(b.project.id, b.local_id)),
  );
  const members = membersOf(read, sprint.id);
  const summary = summarise(planned, members, closed, read.failed.map((f) => f.name));
  return deps.store.mutate(sprint.id, (current) => {
    if (current.state !== "active") {
      throw new SprintError("sprint_not_active", 409, `Sprint ${sprint.id} is ${current.state}; only an active sprint can close`);
    }
    return { ...current, state: "closing", summary, pending: summary.spillover };
  });
}

function failureText(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return (typeof message === "string" ? message : String(err ?? "")).trim() || "unknown error";
}

function removedAlready(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "not_found";
}

// One removal per pending bead; a failure is kept and the pass goes on, so one bad tracker
// does not hold back the rest.
async function runLabelPass(sprint: Sprint, deps: SprintRunDeps): Promise<{ sprint: Sprint; remaining: Remaining[] }> {
  const label = sprintLabel(sprint.id);
  const remaining: Remaining[] = [];
  for (const bead of sprint.pending) {
    try {
      await deps.removeLabel(bead.projectId, bead.id, label);
    } catch (err) {
      if (removedAlready(err)) continue;
      remaining.push({ ...bead, message: failureText(err) });
    }
  }
  const closedAt = deps.now().toISOString();
  const next = await deps.store.mutate(sprint.id, (current) => {
    if (current.state !== "closing") return current;
    const pending: BeadRef[] = remaining.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      id: r.id,
      title: r.title,
      size: r.size,
      points: r.points,
    }));
    return pending.length === 0
      ? { ...current, pending, state: "closed", closedAt }
      : { ...current, pending };
  });
  return { sprint: next, remaining };
}

export async function closeSprint(
  id: string,
  deps: SprintRunDeps,
): Promise<{ sprint: Sprint; remaining: Remaining[] }> {
  let sprint = await deps.store.get(id);
  if (sprint.state === "planned" || sprint.state === "closed") {
    throw new SprintError("sprint_not_active", 409, `Sprint ${id} is ${sprint.state}; only an active sprint can close`);
  }
  if (sprint.state === "active") sprint = await recordSummary(sprint, deps);
  return runLabelPass(sprint, deps);
}
