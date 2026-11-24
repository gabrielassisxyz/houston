import { namespaceBead, namespaceId } from "./aggregate";
import type { AllBeadsResponse, ProjectSummary } from "./aggregate";
import type { Bead } from "./schema";

/**
 * Pure updates over the merged `/api/all/beads` response.
 *
 * Each write endpoint returns the affected bead in its project's own id space
 * (delete returns the removed id). These helpers apply that answer straight to
 * the cached all-projects list without re-reading every tracker, preserving
 * project contiguity, per-project counts, and structural sharing for untouched
 * beads.
 */

function adjustProjectCount(
  projects: ProjectSummary[],
  index: number,
  delta: number,
): ProjectSummary[] {
  const next = projects.slice();
  next[index] = { ...next[index], count: Math.max(0, next[index].count + delta) };
  return next;
}

function findInsertIndex(
  data: AllBeadsResponse,
  projectId: string,
  projectIndex: number,
): number {
  for (let i = data.beads.length - 1; i >= 0; i--) {
    if (data.beads[i].project.id === projectId) return i + 1;
  }
  for (let j = projectIndex + 1; j < data.meta.projects.length; j++) {
    const laterId = data.meta.projects[j].id;
    const firstOfLater = data.beads.findIndex((b) => b.project.id === laterId);
    if (firstOfLater !== -1) return firstOfLater;
  }
  return data.beads.length;
}

/**
 * Inserts or replaces one project's bead in the merged list.
 *
 * `bead` carries its tracker-local id and is namespaced here. A project absent
 * from `meta.projects` leaves the response untouched so unknown projects never
 * enter the list.
 */
export function putBead(data: AllBeadsResponse, projectId: string, bead: Bead): AllBeadsResponse;
export function putBead(data: undefined, projectId: string, bead: Bead): undefined;
export function putBead(
  data: AllBeadsResponse | undefined,
  projectId: string,
  bead: Bead,
): AllBeadsResponse | undefined;
export function putBead(
  data: AllBeadsResponse | undefined,
  projectId: string,
  bead: Bead,
): AllBeadsResponse | undefined {
  if (!data) return undefined;
  const projectIndex = data.meta.projects.findIndex((p) => p.id === projectId);
  if (projectIndex === -1) return data;

  const project = data.meta.projects[projectIndex];
  const namespaced = namespaceBead({ id: project.id, name: project.name }, bead);
  const existingIndex = data.beads.findIndex((b) => b.id === namespaced.id);

  if (existingIndex !== -1) {
    const beads = data.beads.slice();
    beads[existingIndex] = namespaced;
    return { ...data, beads };
  }

  const insertAt = findInsertIndex(data, projectId, projectIndex);
  const beads = [
    ...data.beads.slice(0, insertAt),
    namespaced,
    ...data.beads.slice(insertAt),
  ];
  const projects = adjustProjectCount(data.meta.projects, projectIndex, 1);
  return { ...data, beads, meta: { ...data.meta, projects } };
}

/** Removes one project's bead from the merged list and decrements its project count. */
export function takeBead(
  data: AllBeadsResponse,
  projectId: string,
  localId: string,
): AllBeadsResponse;
export function takeBead(data: undefined, projectId: string, localId: string): undefined;
export function takeBead(
  data: AllBeadsResponse | undefined,
  projectId: string,
  localId: string,
): AllBeadsResponse | undefined;
export function takeBead(
  data: AllBeadsResponse | undefined,
  projectId: string,
  localId: string,
): AllBeadsResponse | undefined {
  if (!data) return undefined;
  const projectIndex = data.meta.projects.findIndex((p) => p.id === projectId);
  if (projectIndex === -1) return data;

  const targetId = namespaceId(projectId, localId);
  const index = data.beads.findIndex((b) => b.id === targetId);
  if (index === -1) return data;

  const beads = [...data.beads.slice(0, index), ...data.beads.slice(index + 1)];
  const projects = adjustProjectCount(data.meta.projects, projectIndex, -1);
  return { ...data, beads, meta: { ...data.meta, projects } };
}

/** Replaces one project's bead with a copy carrying the new status. */
export function setBeadStatus(
  data: AllBeadsResponse,
  projectId: string,
  localId: string,
  status: Bead["status"],
): AllBeadsResponse;
export function setBeadStatus(
  data: undefined,
  projectId: string,
  localId: string,
  status: Bead["status"],
): undefined;
export function setBeadStatus(
  data: AllBeadsResponse | undefined,
  projectId: string,
  localId: string,
  status: Bead["status"],
): AllBeadsResponse | undefined;
export function setBeadStatus(
  data: AllBeadsResponse | undefined,
  projectId: string,
  localId: string,
  status: Bead["status"],
): AllBeadsResponse | undefined {
  if (!data) return undefined;
  const projectIndex = data.meta.projects.findIndex((p) => p.id === projectId);
  if (projectIndex === -1) return data;

  const targetId = namespaceId(projectId, localId);
  const index = data.beads.findIndex((b) => b.id === targetId);
  if (index === -1) return data;

  const existing = data.beads[index];
  if (existing.status === status) return data;

  const beads = data.beads.slice();
  beads[index] = { ...existing, status };
  return { ...data, beads };
}
