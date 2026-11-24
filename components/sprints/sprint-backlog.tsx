"use client";
import type { AllBead } from "@/lib/aggregate";
import { displayId } from "@/lib/aggregate";
import { sprintIdsOf } from "@/lib/sprint-model";

/** The work a sprint can still take: open, not archived, not an epic, and in no sprint. */
export function isOpenWork(bead: AllBead): boolean {
  return (
    bead.status !== "closed" &&
    !bead.labels.includes("archived") &&
    bead.issue_type !== "epic" &&
    sprintIdsOf(bead.labels).length === 0
  );
}

export const newestFirst = (a: AllBead, b: AllBead) =>
  a.priority - b.priority || (b.updated_at ?? "").localeCompare(a.updated_at ?? "");

/** No project chosen means every project; the search reads the title and the bead's own id. */
export function matchesBacklogFilters(bead: AllBead, projects: string[], search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (projects.length > 0 && !projects.includes(bead.project.id)) return false;
  return !needle || bead.title.toLowerCase().includes(needle) || displayId(bead).toLowerCase().includes(needle);
}

export function backlogOf(beads: AllBead[], projects: string[], search: string): AllBead[] {
  return beads
    .filter(isOpenWork)
    .filter((b) => matchesBacklogFilters(b, projects, search))
    .sort(newestFirst);
}

export function BacklogFilters(props: {
  projects: { id: string; name: string }[];
  chosen: string[];
  onToggle: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  return (
    <div className="mb-[10px] flex flex-wrap items-center gap-[6px]">
      <input
        type="search"
        value={props.search}
        onChange={(e) => props.onSearch(e.target.value)}
        placeholder="Search title or id"
        aria-label="Search the backlog"
        className="h-[30px] w-[200px] rounded-[9px] border border-border bg-[var(--surface)] px-[10px] text-[12px]"
      />
      {props.projects.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={props.chosen.includes(p.id)}
          onClick={() => props.onToggle(p.id)}
          className={`h-[30px] rounded-[9px] border border-border px-[10px] text-[12px] font-medium hover:bg-[var(--surface-2)] ${
            props.chosen.includes(p.id) ? "bg-[var(--brand-weak)] text-[var(--brand)]" : "text-[var(--text-2)]"
          }`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
