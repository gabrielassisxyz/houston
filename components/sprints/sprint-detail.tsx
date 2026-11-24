"use client";
import * as React from "react";
import Link from "next/link";
import type { AllBead, FailedProject } from "@/lib/aggregate";
import { pointsOf, sizeOf, sprintBoardHref, sprintLabel, type Sprint } from "@/lib/sprint-model";
import { useAllBeads, useAllBeadsStream } from "@/hooks/use-all-beads";
import { useCloseSprint, useSprints, useStartSprint } from "@/hooks/use-sprints";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toastError } from "@/components/error-toast";
import { useViewerMode } from "@/hooks/use-viewer-mode";
import { moveInEdit, moveOutEdit, sizeEdit, useSprintLabels } from "@/hooks/use-sprint-labels";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { CapacityBar } from "@/components/sprints/capacity-bar";
import { SprintBeadRow } from "@/components/sprints/sprint-bead-row";
import { BacklogFilters, backlogOf, newestFirst } from "@/components/sprints/sprint-backlog";
import { SprintSummaryView, plural } from "@/components/sprints/sprint-summary";

const alertClass = "shrink-0 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-[12.5px] text-destructive";

/** Open members first, then closed ones; each group in the backlog's order. */
function membersOf(beads: AllBead[], sprintId: string): AllBead[] {
  const label = sprintLabel(sprintId);
  const members = beads.filter((b) => b.labels.includes(label)).sort(newestFirst);
  return [...members.filter((b) => b.status !== "closed"), ...members.filter((b) => b.status === "closed")];
}

function Header({ sprintId }: { sprintId: string }) {
  const link = "text-[13px] font-medium text-[var(--text-2)] hover:text-[var(--text)]";
  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-border bg-[var(--surface)] px-4 py-2">
      <h1 className="text-[14px] font-semibold text-[var(--text)]">Sprint {sprintId}</h1>
      <span className="flex-1" />
      <Link href={sprintBoardHref(sprintId)} className={link}>
        Open on the board
      </Link>
      <Link href="/all" className={link}>
        All projects
      </Link>
      <Link href="/sprints" className={link}>
        ← Back to sprints
      </Link>
    </header>
  );
}

function FailedNotice({ failed }: { failed: FailedProject[] }) {
  if (failed.length === 0) return null;
  return (
    <div role="alert" className={alertClass}>
      {failed.map((project) => (
        <p key={project.id}>
          <span className="font-semibold">{project.name}</span> could not be read, so its beads are
          missing from this sprint and from the backlog: {project.error}
        </p>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-[10px] text-[13px] font-[650] uppercase tracking-[.03em] text-[var(--text-3)]">{children}</h2>;
}

function Facts({ sprint, controls = null }: { sprint: Sprint; controls?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[10px]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-[620]">{sprint.name}</div>
        <div className="text-[11px] text-[var(--text-3)]">
          {sprint.start} to {sprint.end}
        </div>
      </div>
      <span className="rounded-full bg-[var(--brand-weak)] px-[9px] py-[2px] text-[11px] font-semibold text-[var(--brand)]">
        {sprint.state}
      </span>
      {controls}
    </div>
  );
}

const primaryButton =
  "h-[34px] rounded-[9px] px-[14px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "h-[34px] rounded-[9px] border border-border px-[14px] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

const pointsOfAll = (beads: AllBead[]) => beads.reduce((sum, b) => sum + pointsOf(b.labels), 0);

function Confirmation(props: {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && !props.busy && props.onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription render={<div />} className="flex flex-col gap-2">
          {props.children}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={props.busy} onClick={props.onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onConfirm}
            className={primaryButton}
            style={{ background: "var(--brand)" }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Start on a planned sprint, Close on an active one; each asks first, with the figures on screen. */
function RunControls({ sprint, members, failed }: { sprint: Sprint; members: AllBead[]; failed: FailedProject[] }) {
  const [asking, setAsking] = React.useState(false);
  const start = useStartSprint();
  const close = useCloseSprint();
  const action = sprint.state === "planned" ? start : close;
  const finished = members.filter((b) => b.status === "closed");
  const open = members.filter((b) => b.status !== "closed");

  async function confirm() {
    try {
      await action.mutateAsync(sprint.id);
    } catch (err) {
      toastError(err);
    }
    setAsking(false);
  }

  if (sprint.state === "planned") {
    return (
      <>
        <button
          type="button"
          disabled={members.length === 0}
          onClick={() => setAsking(true)}
          className={primaryButton}
          style={{ background: "var(--brand)" }}
        >
          Start sprint
        </button>
        <Confirmation open={asking} title="Start this sprint?" confirmLabel="Start" busy={start.isPending} onConfirm={confirm} onCancel={() => setAsking(false)}>
          <p>
            The plan freezes at {plural(members.length, "bead")} and {plural(pointsOfAll(members), "point")}.
          </p>
          {failed.map((project) => (
            <p key={project.id} className="text-destructive">
              <span className="font-semibold">{project.name}</span> could not be read, so its beads will not be part of the plan.
            </p>
          ))}
        </Confirmation>
      </>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setAsking(true)} className={secondaryButton}>
        Close sprint
      </button>
      <Confirmation open={asking} title="Close this sprint?" confirmLabel="Close sprint" busy={close.isPending} onConfirm={confirm} onCancel={() => setAsking(false)}>
        <p>
          {finished.length} done ({plural(pointsOfAll(finished), "point")}).
        </p>
        <p>
          {open.length} not finished ({plural(pointsOfAll(open), "point")}): they leave the sprint and go back to the backlog.
        </p>
      </Confirmation>
    </>
  );
}

/** A close that stopped halfway: the sprint is `closing` and these beads still carry its label. */
function ClosingAlert({ sprint, readOnly }: { sprint: Sprint; readOnly: boolean }) {
  const close = useCloseSprint();
  return (
    <div role="alert" data-testid="closing-alert" className="mb-6 rounded-[13px] border border-destructive/40 bg-destructive/5 p-[14px_18px] text-[12.5px] text-destructive">
      <p className="font-semibold">The close did not finish. These beads still carry the sprint’s label:</p>
      <ul className="my-2 flex flex-col gap-[3px]">
        {sprint.pending.map((b) => (
          <li key={`${b.projectId}:${b.id}`} data-testid="pending-bead">
            <span className="font-semibold">{b.projectName}</span> <span className="font-mono">{b.id}</span> {b.title}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button type="button" disabled={close.isPending} onClick={() => close.mutate(sprint.id, { onError: toastError })} className={secondaryButton}>
          Try again
        </button>
      )}
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="text-[var(--text-3)]">{children}</p>;
}

function SprintBody({ sprint, beads, projects, failed, canEdit, readOnly }: {
  sprint: Sprint;
  beads: AllBead[];
  projects: { id: string; name: string }[];
  failed: FailedProject[];
  canEdit: boolean;
  readOnly: boolean;
}) {
  const labels = useSprintLabels();
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");
  const members = React.useMemo(() => membersOf(beads, sprint.id), [beads, sprint.id]);
  const backlog = React.useMemo(() => backlogOf(beads, chosen, search), [beads, chosen, search]);
  const committed = members.reduce((sum, b) => sum + pointsOf(b.labels), 0);
  const done = members.filter((b) => b.status === "closed").reduce((sum, b) => sum + pointsOf(b.labels), 0);
  const unsized = members.filter((b) => sizeOf(b.labels) === null).length;

  const actionsFor = (bead: AllBead, label: "Move in" | "Move out") =>
    canEdit
      ? {
          label,
          busy: labels.pending.has(bead.id),
          onMove: () =>
            labels.edit(bead, label === "Move in" ? moveInEdit(bead.labels, sprint.id) : moveOutEdit(sprint.id)),
          onSize: (size: Parameters<typeof sizeEdit>[1]) => {
            const edit = sizeEdit(bead.labels, size);
            if (edit) labels.edit(bead, edit);
          },
        }
      : null;

  return (
    <>
      <section className="mb-6 flex flex-col gap-[10px] rounded-[13px] border border-border bg-[var(--surface)] p-[14px_18px]">
        <Facts sprint={sprint} controls={canEdit ? <RunControls sprint={sprint} members={members} failed={failed} /> : null} />
        <CapacityBar committed={committed} capacity={sprint.capacity} unsized={unsized} done={sprint.state === "planned" ? null : done} />
      </section>
      {sprint.state === "closing" && <ClosingAlert sprint={sprint} readOnly={readOnly} />}
      <section data-testid="members" className="mb-6">
        <SectionTitle>In this sprint ({members.length})</SectionTitle>
        {members.length === 0 ? (
          <Message>No bead carries this sprint’s label yet.</Message>
        ) : (
          <ul className="flex flex-col gap-[5px]">
            {members.map((b) => (
              <SprintBeadRow key={b.id} bead={b} actions={b.status === "closed" ? null : actionsFor(b, "Move out")} />
            ))}
          </ul>
        )}
      </section>
      {sprint.state === "closed" && sprint.summary && <SprintSummaryView sprint={sprint} summary={sprint.summary} />}
      {canEdit && (
        <section data-testid="backlog">
          <SectionTitle>Backlog ({backlog.length})</SectionTitle>
          <BacklogFilters
            projects={projects}
            chosen={chosen}
            onToggle={(id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
            search={search}
            onSearch={setSearch}
          />
          {backlog.length === 0 ? (
            <Message>No open bead outside every sprint matches.</Message>
          ) : (
            <ul className="flex flex-col gap-[5px]">
              {backlog.map((b) => (
                <SprintBeadRow key={b.id} bead={b} actions={actionsFor(b, "Move in")} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

export function SprintDetail({ sprintId }: { sprintId: string }) {
  const viewer = useViewerMode();
  // Until the mode is known the page behaves as read-only, as the project page does.
  const readOnly = viewer.data?.readOnly ?? true;
  const sprintsQuery = useSprints();
  const beadsQuery = useAllBeads();
  useAllBeadsStream();
  const sprint = sprintsQuery.data?.sprints.find((s) => s.id === sprintId);
  const beads = React.useMemo<AllBead[]>(() => beadsQuery.data?.beads ?? [], [beadsQuery.data]);
  const failed = beadsQuery.data?.meta.failed ?? [];
  const projects = beadsQuery.data?.meta.projects ?? [];
  const canEdit = !readOnly && (sprint?.state === "planned" || sprint?.state === "active");

  let content: React.ReactNode;
  if (sprintsQuery.error) {
    content = (
      <p role="alert" className="text-destructive">
        Couldn’t read the sprints: {(sprintsQuery.error as Error).message}
      </p>
    );
  } else if (!sprintsQuery.data) {
    content = <Message>Loading sprint…</Message>;
  } else if (!sprint) {
    content = (
      <div className="flex flex-col items-start gap-3">
        <p>No sprint starts on {sprintId}.</p>
        <Link href="/sprints" className="text-[13px] font-medium text-[var(--brand)]">
          Back to sprints
        </Link>
      </div>
    );
  } else if (beadsQuery.data) {
    content = <SprintBody sprint={sprint} beads={beads} projects={projects} failed={failed} canEdit={canEdit} readOnly={readOnly} />;
  } else if (beadsQuery.error) {
    content = (
      <>
        <section className="mb-6 rounded-[13px] border border-border bg-[var(--surface)] p-[14px_18px]">
          <Facts sprint={sprint} />
        </section>
        <p role="alert" className="text-destructive">
          Couldn’t read the beads, so neither the sprint’s beads nor the backlog can be shown.
        </p>
      </>
    );
  } else {
    content = <Message>Loading beads…</Message>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground text-sm">
      <ReadOnlyBanner />
      <Header sprintId={sprintId} />
      <FailedNotice failed={failed} />
      {!beadsQuery.data && beadsQuery.error && (
        <div role="alert" className={alertClass}>
          Couldn’t read the beads: {(beadsQuery.error as Error).message}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] p-[28px]">{content}</div>
      </main>
    </div>
  );
}
