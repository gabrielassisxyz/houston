"use client";
import type * as React from "react";
import type { AllBead } from "@/lib/aggregate";
import { displayId } from "@/lib/aggregate";
import { pointsOf, sizeOf, type Size } from "@/lib/sprint-model";
import { ProjectChip } from "@/components/project-chip";

const SIZES: Size[] = ["S", "M", "L", "XL"];

const smallButton =
  "h-[26px] rounded-[8px] border border-border px-[9px] text-[11.5px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

interface RowProps {
  bead: AllBead;
  /** Null shows the row with no control at all: a closed sprint, or read-only mode. */
  actions: { label: "Move in" | "Move out"; onMove: () => void; onSize: (size: Size) => void; busy: boolean } | null;
  /** A control in front of the row, for a list whose rows are chosen rather than moved. */
  lead?: React.ReactNode;
  /** Said in place of the points: an epic has beads under it, not a size of its own. */
  trail?: string;
}

export function SprintBeadRow({ bead, actions, lead, trail }: RowProps) {
  const size = sizeOf(bead.labels);
  const own = displayId(bead);
  return (
    <li
      data-testid="sprint-bead"
      data-bead-id={bead.id}
      className="flex items-center gap-[8px] rounded-[10px] border border-border bg-[var(--surface)] px-[10px] py-[7px]"
    >
      {lead}
      <ProjectChip bead={bead} />
      <span className="flex-shrink-0 font-mono text-[11px] text-[var(--text-3)]">{own}</span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${bead.status === "closed" ? "text-[var(--text-3)] line-through" : ""}`}>
        {bead.title}
      </span>
      <span className="flex-shrink-0 text-[11px] text-[var(--text-3)]">
        {bead.issue_type} · P{bead.priority}
      </span>
      <span className={`${trail ? "" : "w-[54px] "}flex-shrink-0 whitespace-nowrap text-right font-mono text-[11px] text-[var(--text-3)]`}>
        {trail ?? (size ? `${pointsOf(bead.labels)} pts` : "no size")}
      </span>
      {actions && (
        <>
          <span role="group" aria-label={`Size of ${own}`} className="flex flex-shrink-0 gap-[3px]">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={actions.busy}
                aria-pressed={size === s}
                aria-label={`Size ${s} for ${own}`}
                onClick={() => actions.onSize(s)}
                className={`${smallButton} ${size === s ? "bg-[var(--brand-weak)] text-[var(--brand)]" : ""}`}
              >
                {s}
              </button>
            ))}
          </span>
          <button
            type="button"
            disabled={actions.busy}
            aria-label={`${actions.label} ${own}`}
            onClick={actions.onMove}
            className={smallButton}
          >
            {actions.label}
          </button>
        </>
      )}
    </li>
  );
}
