"use client";
import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { AllBead, FailedProject } from "@/lib/aggregate";
import {
  pointsOf,
  sizeOf,
  sprintBoardHref,
  sprintIdsOf,
  sprintLabel,
  type Sprint,
} from "@/lib/sprint-model";
import { useAllBeads, useAllBeadsStream } from "@/hooks/use-all-beads";
import { useDeleteSprint, useSprints } from "@/hooks/use-sprints";
import { useViewerMode } from "@/hooks/use-viewer-mode";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { toastError } from "@/components/error-toast";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SprintForm } from "@/components/sprints/sprint-form";
import { SprintBeadPicker } from "@/components/sprints/sprint-bead-picker";

interface SprintRow {
  sprint: Sprint;
  beads: number;
  committed: number;
  unsized: number;
}

const running = (s: Sprint) => s.state === "active" || s.state === "closing";

/** Running sprints first, then planned by start ascending, then closed by start descending. */
function orderSprints(sprints: Sprint[]): Sprint[] {
  const rank = (s: Sprint) => (running(s) ? 0 : s.state === "planned" ? 1 : 2);
  return [...sprints].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const byStart = a.start.localeCompare(b.start);
    return rank(a) === 2 ? -byStart : byStart;
  });
}

// Membership lives on the beads, so every figure here is computed from the merged list.
function rowsOf(sprints: Sprint[], beads: AllBead[]): SprintRow[] {
  return orderSprints(sprints).map((sprint) => {
    const label = sprintLabel(sprint.id);
    const members = beads.filter((b) => b.labels.includes(label));
    return {
      sprint,
      beads: members.length,
      committed: members.reduce((sum, b) => sum + pointsOf(b.labels), 0),
      unsized: members.filter((b) => sizeOf(b.labels) === null).length,
    };
  });
}

interface Orphans {
  labels: { label: string; beads: number }[];
  multiple: number;
}

function orphansOf(sprints: Sprint[], beads: AllBead[]): Orphans {
  const known = new Set(sprints.map((s) => s.id));
  const counts = new Map<string, number>();
  let multiple = 0;
  for (const bead of beads) {
    const ids = [...new Set(sprintIdsOf(bead.labels))];
    if (ids.length > 1) multiple += 1;
    for (const id of ids) if (!known.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const labels = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => ({ label: sprintLabel(id), beads: n }));
  return { labels, multiple };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A sprint's figures come from the bead list. Until it has arrived, or when it could not be
// read, a row must not say "0 beads": that reads as an empty sprint.
type BeadState = "ready" | "loading" | "failed";
const editable = (s: Sprint) => s.state === "planned" || s.state === "active";

function FailedNotice({ failed }: { failed: FailedProject[] }) {
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-[12.5px] text-destructive"
    >
      {failed.map((project) => (
        <p key={project.id}>
          <span className="font-semibold">{project.name}</span> could not be read, so its beads are
          missing from these counts: {project.error}
        </p>
      ))}
    </div>
  );
}

function Header({ onCreate, readOnly }: { onCreate: () => void; readOnly: boolean }) {
  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-border bg-[var(--surface)] px-4 py-2">
      <h1 className="text-[14px] font-semibold text-[var(--text)]">Sprints</h1>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onCreate}
        disabled={readOnly}
        className="flex h-[36px] items-center gap-[7px] rounded-[9px] px-[14px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--brand)" }}
      >
        <Plus size={15} />
        New sprint
      </button>
      <Link href="/all" className="text-[13px] font-medium text-[var(--text-2)] hover:text-[var(--text)]">
        All projects
      </Link>
      <Link href="/" className="text-[13px] font-medium text-[var(--text-2)] hover:text-[var(--text)]">
        ← Back to projects
      </Link>
    </header>
  );
}

const rowButton =
  "h-[30px] rounded-[9px] border border-border px-[10px] text-[12px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

function SprintRowView(props: {
  row: SprintRow;
  beadState: BeadState;
  readOnly: boolean;
  onAdd: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { row, readOnly, beadState } = props;
  const counted = beadState === "ready";
  const { sprint } = row;
  const pct = sprint.capacity > 0 ? Math.min(100, Math.round((row.committed / sprint.capacity) * 100)) : 0;
  const over = row.committed > sprint.capacity;
  return (
    <li
      data-testid="sprint-row"
      data-sprint-id={sprint.id}
      className="flex flex-col gap-[10px] rounded-[13px] border border-border bg-[var(--surface)] p-[14px_18px]"
    >
      <div className="flex items-center gap-[10px]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-[620]">
            <Link href={`/sprints/${encodeURIComponent(sprint.id)}`} className="hover:underline">
              {sprint.name}
            </Link>
          </div>
          <div className="text-[11px] text-[var(--text-3)]">
            {sprint.start} to {sprint.end}
          </div>
        </div>
        <span className="rounded-full bg-[var(--brand-weak)] px-[9px] py-[2px] text-[11px] font-semibold text-[var(--brand)]">
          {sprint.state}
        </span>
        <Link
          href={sprintBoardHref(sprint.id)}
          aria-label={`Open ${sprint.name} on the board`}
          className={`${rowButton} inline-flex items-center`}
        >
          Board
        </Link>
        {editable(sprint) && (
          <button
            type="button"
            className={rowButton}
            // The picker lists beads, so it has nothing to offer before they have been read.
            disabled={readOnly || !counted}
            onClick={props.onAdd}
            aria-label={`Add beads to ${sprint.name}`}
          >
            Add beads
          </button>
        )}
        {editable(sprint) && (
          <button type="button" className={rowButton} disabled={readOnly} onClick={props.onEdit} aria-label={`Edit ${sprint.name}`}>
            Edit
          </button>
        )}
        {sprint.state === "planned" && (
          <button type="button" className={rowButton} disabled={readOnly} onClick={props.onDelete} aria-label={`Delete ${sprint.name}`}>
            Delete
          </button>
        )}
      </div>
      <div className="flex items-center gap-[9px]">
        <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${counted ? pct : 0}%`, background: over ? "var(--danger,#ef4444)" : "var(--brand)" }}
          />
        </div>
        <span className="flex-shrink-0 font-mono text-[11px] text-[var(--text-3)]">
          {counted ? row.committed : "…"} / {sprint.capacity} points
        </span>
      </div>
      <div className="flex gap-3 text-[12px] text-[var(--text-3)]">
        {counted ? (
          <>
            <span>{plural(row.beads, "bead")}</span>
            {row.unsized > 0 && <span>{row.unsized} unsized</span>}
          </>
        ) : (
          <span>{beadState === "failed" ? "Beads not counted" : "Counting beads…"}</span>
        )}
      </div>
    </li>
  );
}

function DeleteDialog({ row, beadState, onClose }: { row: SprintRow | null; beadState: BeadState; onClose: () => void }) {
  const remove = useDeleteSprint();
  const sprint = row?.sprint;
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>Delete {sprint?.name}?</DialogTitle>
        <DialogDescription>
          {beadState !== "ready"
            ? "The beads have not been read, so it is not known how many carry this sprint's label."
            : row && row.beads > 0
            ? `${plural(row.beads, "bead")} keep${row.beads === 1 ? "s" : ""} the label ${sprintLabel(row.sprint.id)} and will show up below as a label that matches no sprint.`
            : "No bead carries this sprint's label."}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={rowButton}>
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              if (!sprint) return;
              remove.mutate(sprint.id, { onSuccess: onClose, onError: toastError });
            }}
            className="h-[30px] rounded-[9px] bg-destructive px-[12px] text-[12px] font-semibold text-white disabled:opacity-50"
          >
            Delete sprint
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrphanSection({ orphans }: { orphans: Orphans }) {
  if (orphans.labels.length === 0 && orphans.multiple === 0) return null;
  return (
    <section data-testid="orphan-labels" className="mt-6">
      <h2 className="mb-[10px] text-[13px] font-[650] uppercase tracking-[.03em] text-[var(--text-3)]">
        Labels that match no sprint
      </h2>
      <ul className="flex flex-col gap-[6px] text-[13px]">
        {orphans.labels.map((o) => (
          <li key={o.label}>
            <span className="font-mono">{o.label}</span> on {plural(o.beads, "bead")}
          </li>
        ))}
        {orphans.multiple > 0 && (
          <li>{plural(orphans.multiple, "bead")} carry more than one sprint label.</li>
        )}
      </ul>
    </section>
  );
}

export function SprintsShell() {
  const viewer = useViewerMode();
  // Until the mode is known the page behaves as read-only, as the project page does.
  const readOnly = viewer.data?.readOnly ?? true;
  const sprintsQuery = useSprints();
  const beadsQuery = useAllBeads();
  useAllBeadsStream();
  const [form, setForm] = React.useState<{ open: boolean; sprint: Sprint | null }>({ open: false, sprint: null });
  const [deleting, setDeleting] = React.useState<SprintRow | null>(null);
  const [adding, setAdding] = React.useState<Sprint | null>(null);

  const sprints = React.useMemo(() => sprintsQuery.data?.sprints ?? [], [sprintsQuery.data]);
  const beads = React.useMemo<AllBead[]>(() => beadsQuery.data?.beads ?? [], [beadsQuery.data]);
  const failed = beadsQuery.data?.meta.failed ?? [];
  const beadState: BeadState = beadsQuery.data ? "ready" : beadsQuery.error ? "failed" : "loading";
  const rows = React.useMemo(() => rowsOf(sprints, beads), [sprints, beads]);
  const orphans = React.useMemo(() => orphansOf(sprints, beads), [sprints, beads]);
  const openForm = (sprint: Sprint | null) => setForm({ open: true, sprint });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground text-sm">
      <ReadOnlyBanner />
      <Header onCreate={() => openForm(null)} readOnly={readOnly} />
      <FailedNotice failed={failed} />
      {beadState === "failed" && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-[12.5px] text-destructive"
        >
          Couldn’t read the beads, so no sprint is counted: {(beadsQuery.error as Error).message}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] p-[28px]">
          {sprintsQuery.error ? (
            <p role="alert" className="text-destructive">
              Couldn’t read the sprints: {(sprintsQuery.error as Error).message}
            </p>
          ) : sprintsQuery.isLoading ? (
            <p className="text-[var(--text-3)]">Loading sprints…</p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-[13px] border border-dashed border-[var(--border-strong)] p-8 text-[var(--text-3)]">
              <p>No sprints yet.</p>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => openForm(null)}
                className="h-[36px] rounded-[9px] px-[14px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "var(--brand)" }}
              >
                Create a sprint
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-[14px]">
              {rows.map((row) => (
                <SprintRowView
                  key={row.sprint.id}
                  row={row}
                  beadState={beadState}
                  readOnly={readOnly}
                  onAdd={() => setAdding(row.sprint)}
                  onEdit={() => openForm(row.sprint)}
                  onDelete={() => setDeleting(row)}
                />
              ))}
            </ul>
          )}
          {beadsQuery.data && <OrphanSection orphans={orphans} />}
        </div>
      </main>
      <SprintForm
        sprint={form.sprint}
        open={form.open}
        readOnly={readOnly}
        onOpenChange={(open) => setForm((f) => ({ ...f, open }))}
      />
      <DeleteDialog row={deleting} beadState={beadState} onClose={() => setDeleting(null)} />
      <SprintBeadPicker
        // Closed rather than left open under read-only mode: it holds nothing but a way to write.
        sprint={readOnly ? null : adding}
        beads={beads}
        projects={beadsQuery.data?.meta.projects ?? []}
        onClose={() => setAdding(null)}
      />
    </div>
  );
}
