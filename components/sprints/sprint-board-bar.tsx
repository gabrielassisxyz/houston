"use client";
import Link from "next/link";
import { filtersFromSearchParams } from "@/lib/filters";
import { pointsOf, sprintIdOfFilter, sprintLabel } from "@/lib/sprint-model";
import { useSprints } from "@/hooks/use-sprints";
import { useUrlState } from "@/hooks/use-url-state";
import { useApp } from "@/components/app-context";

const control = "text-[12.5px] font-medium text-[var(--text-2)] hover:text-[var(--text)]";

function Bar({ sprintId }: { sprintId: string }) {
  const { updateUrl } = useUrlState();
  const { beads, loading } = useApp();
  const sprint = useSprints().data?.sprints.find((s) => s.id === sprintId);
  // A label that matches no sprint is a plain label filter, and the page stays as it is.
  if (!sprint) return null;

  const label = sprintLabel(sprint.id);
  const committed = beads.filter((b) => b.labels.includes(label)).reduce((sum, b) => sum + pointsOf(b.labels), 0);
  // Both parameters are what made this a sprint view; every other one is the reader's own.
  const leave = () =>
    updateUrl((params) => {
      params.delete("label");
      params.delete("done");
    });

  return (
    <div
      data-testid="sprint-board-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-[12px] gap-y-1 border-b border-border bg-[var(--brand-weak)] px-4 py-2"
    >
      <span className="text-[11px] font-[650] uppercase tracking-[.03em] text-[var(--brand)]">Sprint</span>
      <span className="text-[13px] font-[620] text-[var(--text)]">{sprint.name}</span>
      <span className="text-[11.5px] text-[var(--text-2)]">
        {sprint.start} to {sprint.end}
      </span>
      <span className="rounded-full bg-[var(--surface)] px-[9px] py-[2px] text-[11px] font-semibold text-[var(--brand)]">
        {sprint.state}
      </span>
      <span className="font-mono text-[11px] text-[var(--text-2)]">
        {loading ? "…" : committed} / {sprint.capacity} points
      </span>
      <span className="flex-1" />
      <Link href={`/sprints/${encodeURIComponent(sprint.id)}`} className={control}>
        ← Back to sprint
      </Link>
      <button type="button" onClick={leave} className={control}>
        Leave sprint view
      </button>
    </div>
  );
}

/**
 * Says which sprint the page over every project is showing when its label filter narrows it to
 * one. The sprints are asked for only then: with no such filter the page knows nothing of them.
 */
export function SprintBoardBar() {
  const { searchParams } = useUrlState();
  const sprintId = sprintIdOfFilter(filtersFromSearchParams(searchParams).labels);
  return sprintId === null ? null : <Bar sprintId={sprintId} />;
}
