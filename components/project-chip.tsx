import type { Bead } from "@/lib/schema";
import { projectOf } from "@/lib/aggregate";

/**
 * Names the project a bead came from on the merged board. Renders nothing for
 * a bead without one, so a single project's page is untouched. The name is
 * truncated: it is free text and must not widen the row it sits in.
 */
export function ProjectChip({ bead }: { bead: Bead }) {
  const project = projectOf(bead);
  if (!project) return null;
  return (
    <span
      data-project-chip
      title={`Project: ${project.name}`}
      className="inline-flex max-w-[110px] flex-shrink-0 items-center rounded-md border border-border bg-[var(--surface-2)] px-[6px] py-px text-[10.5px] font-[550] text-[var(--text-3)]"
    >
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
    </span>
  );
}
