"use client";
import type { BeadRef, Sprint, SprintSummary } from "@/lib/sprint-model";

const sum = (beads: BeadRef[]) => beads.reduce((total, b) => total + b.points, 0);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function BeadList({ beads }: { beads: BeadRef[] }) {
  if (beads.length === 0) return null;
  return (
    <ul className="mt-[8px] flex flex-col gap-[5px]">
      {beads.map((b) => (
        <li
          key={`${b.projectId}:${b.id}`}
          data-testid="summary-bead"
          data-bead-id={`${b.projectId}:${b.id}`}
          className="flex items-center gap-[8px] rounded-[10px] border border-border bg-[var(--surface)] px-[10px] py-[7px]"
        >
          <span className="flex-shrink-0 text-[11px] font-medium text-[var(--text-2)]">{b.projectName}</span>
          <span className="flex-shrink-0 font-mono text-[11px] text-[var(--text-3)]">{b.id}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{b.title}</span>
          <span className="flex-shrink-0 font-mono text-[11px] text-[var(--text-3)]">{b.size ?? "no size"}</span>
        </li>
      ))}
    </ul>
  );
}

function Group(props: { id: string; title: string; count: number; points: number; beads: BeadRef[] }) {
  return (
    <section data-testid={`summary-${props.id}`} className="mb-6">
      <h2 className="mb-[2px] text-[13px] font-[650] uppercase tracking-[.03em] text-[var(--text-3)]">{props.title}</h2>
      <p data-testid="summary-figures" className="text-[13px] text-[var(--text-2)]">
        {plural(props.count, "bead")} · {plural(props.points, "point")}
      </p>
      <BeadList beads={props.beads} />
    </section>
  );
}

/** What a closed sprint stored: the plan, what came of it and what changed after the start. */
export function SprintSummaryView({ sprint, summary }: { sprint: Sprint; summary: SprintSummary }) {
  const planned = sprint.planned ?? [];
  return (
    <div data-testid="sprint-summary">
      <Group id="planned" title="Planned" count={summary.plannedCount} points={summary.plannedPoints} beads={planned} />
      <Group id="done" title="Done" count={summary.done.length} points={sum(summary.done)} beads={summary.done} />
      <Group
        id="spillover"
        title="Spilled over"
        count={summary.spillover.length}
        points={sum(summary.spillover)}
        beads={summary.spillover}
      />
      <Group id="added" title="Added after the start" count={summary.added.length} points={sum(summary.added)} beads={summary.added} />
      <Group
        id="removed"
        title="Removed after the start"
        count={summary.removed.length}
        points={sum(summary.removed)}
        beads={summary.removed}
      />
      {summary.unreadable.length > 0 && (
        <div data-testid="summary-unreadable" role="alert" className="rounded-[10px] border border-destructive/40 bg-destructive/5 px-[12px] py-[8px] text-[12.5px] text-destructive">
          {summary.unreadable.map((name) => (
            <p key={name}>
              <span className="font-semibold">{name}</span> could not be read when this sprint closed, so its beads are not counted above.
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
