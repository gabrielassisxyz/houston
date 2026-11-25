import { BEAD_STATUSES, BEAD_TYPES, type Bead } from "./schema";
import { beadOrigin } from "./attribution";
import { projectOf } from "./aggregate";

/**
 * Shared bead filter model used by both the Board and List views. Every facet is
 * multi-select; an empty array means "no constraint" (show all). `search` matches
 * id / title / assignee / labels / external_ref.
 */
export interface Filters {
  status: string[];
  type: string[];
  priority: number[];
  origin: string[];
  labels: string[];
  assignee: string[];
  projects: string[];
  search: string;
}

export const emptyFilters: Filters = {
  status: [],
  type: [],
  priority: [],
  origin: [],
  labels: [],
  assignee: [],
  projects: [],
  search: "",
};

const FILTER_PARAMS = [
  "status",
  "type",
  "priority",
  "origin",
  "label",
  "assignee",
  "project",
  "q",
] as const;

type SearchParamsReader = Pick<URLSearchParams, "get" | "getAll">;

function distinctValues(params: SearchParamsReader, name: string): string[] {
  return [...new Set(params.getAll(name).filter(Boolean))];
}

function boundedValues(
  params: SearchParamsReader,
  name: string,
  allowed: readonly string[],
): string[] {
  return distinctValues(params, name).filter((value) => allowed.includes(value));
}

/** Parse the shared Board/List filters from bookmarkable query parameters. */
export function filtersFromSearchParams(params: SearchParamsReader): Filters {
  return {
    status: boundedValues(params, "status", BEAD_STATUSES),
    type: boundedValues(params, "type", BEAD_TYPES),
    priority: [...new Set(
      distinctValues(params, "priority")
        .filter((value) => /^[0-4]$/.test(value))
        .map(Number)
        .filter(
          (priority) =>
            Number.isInteger(priority) && priority >= 0 && priority <= 4,
        ),
    )],
    origin: boundedValues(params, "origin", ["human", "agent"]),
    labels: distinctValues(params, "label"),
    // Unlike other string facets, empty explicitly means "Unassigned".
    assignee: [...new Set(params.getAll("assignee"))],
    projects: distinctValues(params, "project"),
    search: params.get("q") ?? "",
  };
}

/** Replace only filter parameters, preserving every unrelated query parameter. */
export function writeFiltersToSearchParams(
  params: URLSearchParams,
  filters: Filters,
): void {
  for (const name of FILTER_PARAMS) params.delete(name);
  for (const status of filters.status) params.append("status", status);
  for (const type of filters.type) params.append("type", type);
  for (const priority of filters.priority) params.append("priority", String(priority));
  for (const origin of filters.origin) params.append("origin", origin);
  for (const label of filters.labels) params.append("label", label);
  for (const assignee of filters.assignee) params.append("assignee", assignee);
  for (const project of filters.projects) params.append("project", project);
  if (filters.search) params.set("q", filters.search);
}

/**
 * Blank facet value for beads with no assignee. A real username must never
 * collide with the Unassigned option.
 */
export const UNASSIGNED = "";

/** A bead's assignee normalized to a facet value (empty/blank → UNASSIGNED). */
export function beadAssignee(b: Bead): string {
  return b.assignee?.trim() || UNASSIGNED;
}

/**
 * The distinct assignees in use across a bead set, sorted, as filter options —
 * with "Unassigned" first when any bead lacks one. Callers pass ALL beads (not
 * the filtered set), same as labelOptionsFrom.
 */
export function assigneeOptionsFrom(beads: Bead[]): { value: string; label: string }[] {
  const s = new Set<string>();
  let hasUnassigned = false;
  for (const b of beads) {
    const a = beadAssignee(b);
    if (a === UNASSIGNED) hasUnassigned = true;
    else s.add(a);
  }
  const opts = [...s].sort().map((a) => ({ value: a, label: a }));
  return hasUnassigned ? [{ value: UNASSIGNED, label: "Unassigned" }, ...opts] : opts;
}

/**
 * `archived` is state, not a tag — it has its own dedicated toggle in the
 * FilterBar and the views hide on it — so it never appears as a label facet
 * option.
 */
export const ARCHIVED_LABEL = "archived";

/**
 * The distinct labels in use across a bead set, sorted, as filter options.
 * Callers pass ALL beads (not the filtered set) so selecting one label doesn't
 * make the other options vanish from the dropdown.
 */
export function labelOptionsFrom(beads: Bead[]): { value: string; label: string }[] {
  const s = new Set<string>();
  for (const b of beads) for (const l of b.labels ?? []) if (l !== ARCHIVED_LABEL) s.add(l);
  return [...s].sort().map((l) => ({ value: l, label: l }));
}

/**
 * The projects present in a bead set, sorted by name, as filter options. The value is the
 * project id. Empty when no bead is tagged, which is how a single project's page shows no
 * Project facet.
 */
export function projectOptionsFrom(beads: Bead[]): { value: string; label: string }[] {
  const names = new Map<string, string>();
  for (const b of beads) {
    const project = projectOf(b);
    if (project) names.set(project.id, project.name);
  }
  return [...names]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/** Count of active facet selections (excludes free-text search). */
export function activeFilterCount(f: Filters): number {
  return (
    f.status.length +
    f.type.length +
    f.priority.length +
    f.origin.length +
    f.labels.length +
    f.assignee.length +
    f.projects.length
  );
}

export function matchesFilters(b: Bead, f: Filters, humanAllowlist: string[]): boolean {
  if (f.status.length && !f.status.includes(b.status)) return false;
  if (f.type.length && !f.type.includes(b.issue_type)) return false;
  if (f.priority.length && !f.priority.includes(b.priority)) return false;
  if (f.origin.length && !f.origin.includes(beadOrigin(b, humanAllowlist))) return false;
  if (f.assignee.length && !f.assignee.includes(beadAssignee(b))) return false;
  // A bead with no project never matches a chosen project.
  const project = projectOf(b);
  if (f.projects.length && (!project || !f.projects.includes(project.id))) return false;
  // OR within the facet, like every other facet above; AND across facets.
  if (f.labels.length && !f.labels.some((l) => (b.labels ?? []).includes(l))) return false;
  const q = f.search.trim().toLowerCase();
  if (
    q &&
    !(
      b.title.toLowerCase().includes(q) ||
      b.id.toLowerCase().includes(q) ||
      (b.assignee ?? "").toLowerCase().includes(q) ||
      (b.labels ?? []).some((l) => l.toLowerCase().includes(q)) ||
      (b.external_ref ?? "").toLowerCase().includes(q)
    )
  )
    return false;
  return true;
}

/** Immutable toggle of a value in a string array. */
export function toggleStr(arr: string[], v: string): string[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

/** Immutable toggle of a value in a number array. */
export function toggleNum(arr: number[], v: number): number[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}
