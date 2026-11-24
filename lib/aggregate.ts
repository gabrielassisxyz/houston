import type { Bead, Dependency } from "./schema";

/**
 * Pure helpers for merging the beads of several projects into one list.
 *
 * A bead id is only unique inside its tracker, and the interface keys
 * everything by it, so ids are rewritten as `<project id>:<original id>` where
 * the lists are merged. Nothing here may import code that only runs on the
 * server: the client and the tests load this file as it is.
 */

/** A real project id is a folder slug and cannot contain "@", so it never collides. */
export const ALL_PROJECT_ID = "@all";

export interface ProjectRef {
  id: string;
  name: string;
}

export type TrackerKind = "bd" | "br";

/** A bead as `/api/all/beads` returns it. */
export type AllBead = Bead & {
  local_id: string;
  project: ProjectRef;
};

export interface ProjectSummary extends ProjectRef {
  kind: TrackerKind;
  count: number;
}

export interface FailedProject extends ProjectRef {
  error: string;
}

export interface AllBeadsMeta {
  kind: "all";
  readOnly: boolean;
  humanActor: string;
  humanAllowlist: string[];
  pollIntervalMs: number;
  projects: ProjectSummary[];
  failed: FailedProject[];
}

export interface AllBeadsResponse {
  beads: AllBead[];
  meta: AllBeadsMeta;
}

const SEPARATOR = ":";

export function namespaceId(projectId: string, id: string): string {
  return `${projectId}${SEPARATOR}${id}`;
}

/**
 * Splits on the first colon only: project ids never contain one, while an
 * original id may. Returns null for an id that was never namespaced.
 */
export function splitId(id: string): { projectId: string; localId: string } | null {
  const at = id.indexOf(SEPARATOR);
  if (at <= 0) return null;
  return { projectId: id.slice(0, at), localId: id.slice(at + 1) };
}

function namespaceDependency(projectId: string, dep: Dependency): Dependency {
  const next: Dependency = {
    ...dep,
    depends_on_id: namespaceId(projectId, dep.depends_on_id),
  };
  if (dep.issue_id !== undefined) next.issue_id = namespaceId(projectId, dep.issue_id);
  return next;
}

export function namespaceBead(project: ProjectRef, bead: Bead): AllBead {
  const next: AllBead = {
    ...bead,
    id: namespaceId(project.id, bead.id),
    local_id: bead.id,
    dependencies: bead.dependencies.map((d) => namespaceDependency(project.id, d)),
    project: { id: project.id, name: project.name },
  };
  if (bead.parent) next.parent = namespaceId(project.id, bead.parent);
  return next;
}

type MaybeAllBead = Pick<Bead, "id"> & Partial<Pick<AllBead, "local_id" | "project">>;

/** The id a person knows the bead by: the tracker's own, never the namespaced one. */
export function displayId(bead: MaybeAllBead): string {
  if (bead.local_id !== undefined) return bead.local_id;
  return bead.id;
}

/** The project a merged bead came from; undefined for a bead of a single project. */
export function projectOf(bead: MaybeAllBead): ProjectRef | undefined {
  return bead.project;
}
