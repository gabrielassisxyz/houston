import type { Bead } from "./schema";

/** How far back closed beads are shown: none, the last N days, or all of them. */
export type DoneWindow = "none" | 7 | 28 | 90 | 365 | "all";

export const DONE_WINDOW_OPTIONS: ReadonlyArray<{ value: DoneWindow; label: string }> = [
  { value: "none", label: "Hidden" },
  { value: 7, label: "Last 7 days" },
  { value: 28, label: "Last 4 weeks" },
  { value: 90, label: "Last 3 months" },
  { value: 365, label: "Last 12 months" },
  { value: "all", label: "All time" },
];

const DAY_MS = 86_400_000;

/** The `done` URL parameter's value for a window. */
export function doneWindowParam(window: DoneWindow): string {
  return String(window);
}

/** Absent or unrecognised parameters mean the page's own default. */
export function readDoneWindow(raw: string | null, fallback: DoneWindow): DoneWindow {
  const match = DONE_WINDOW_OPTIONS.find((option) => doneWindowParam(option.value) === raw);
  return match ? match.value : fallback;
}

/** What to write for a choice: nothing at all when it is the page's default. */
export function doneWindowToWrite(choice: DoneWindow, fallback: DoneWindow): string | null {
  return choice === fallback ? null : doneWindowParam(choice);
}

type Closable = Pick<Bead, "status" | "closed_at" | "updated_at">;

/** Whether the bead stays on screen; only closed beads are ever left out. */
export function isInDoneWindow(bead: Closable, window: DoneWindow, now: number): boolean {
  if (bead.status !== "closed" || window === "all") return true;
  if (window === "none") return false;
  const closedAt = Date.parse(bead.closed_at || bead.updated_at || "");
  return Number.isFinite(closedAt) && closedAt >= now - window * DAY_MS;
}
