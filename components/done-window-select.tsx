"use client";
import * as React from "react";
import { DONE_WINDOW_OPTIONS, type DoneWindow } from "@/lib/done-window";

// All time keeps the empty option value the board's selector has always had, which the
// URL navigation test selects by; the URL's own spelling lives in lib/done-window.ts.
const optionValue = (window: DoneWindow): string => (window === "all" ? "" : String(window));

const COLUMN_HEADER_LOOK =
  "cursor-pointer rounded-[7px] border border-border bg-[var(--surface-2)] px-[7px] py-[3px] text-[11px] text-[var(--text-2)] outline-none";

export function DoneWindowSelect({
  value,
  onChange,
  className = COLUMN_HEADER_LOOK,
}: {
  value: DoneWindow;
  onChange: (choice: DoneWindow) => void;
  className?: string;
}) {
  return (
    <select
      aria-label="Done window"
      value={optionValue(value)}
      onChange={(e) => {
        const chosen = DONE_WINDOW_OPTIONS.find((option) => optionValue(option.value) === e.target.value);
        if (chosen) onChange(chosen.value);
      }}
      title="Show only beads closed within this window"
      className={className}
    >
      {DONE_WINDOW_OPTIONS.map((option) => (
        <option key={optionValue(option.value)} value={optionValue(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
