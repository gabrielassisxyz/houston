"use client";
import * as React from "react";
import type { AllBead, ProjectSummary } from "@/lib/aggregate";
import { displayId } from "@/lib/aggregate";
import { descendantsOf } from "@/lib/beads-view";
import type { Sprint } from "@/lib/sprint-model";
import { useAddToSprint } from "@/hooks/use-sprint-labels";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SprintBeadRow } from "@/components/sprints/sprint-bead-row";
import { plural } from "@/components/sprints/sprint-summary";
import {
  BacklogFilters,
  isOpenWork,
  matchesBacklogFilters,
  newestFirst,
} from "@/components/sprints/sprint-backlog";

const BD_NOTE = "labels cannot be edited on a bd project";

const primaryButton =
  "h-[34px] rounded-[9px] px-[14px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "h-[34px] rounded-[9px] border border-border px-[14px] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

/** A row of the picker: a bead that can go in, or an epic standing for the beads under it. */
interface Choice {
  bead: AllBead;
  /** The beads under an epic that can go in; null for a bead that goes in itself. */
  under: AllBead[] | null;
}

// An epic is a way to choose and never a member, so it is listed only when it leads somewhere.
function choicesOf(beads: AllBead[]): Choice[] {
  const offered = beads.filter(isOpenWork);
  const offeredIds = new Set(offered.map((b) => b.id));
  const epics = beads
    .filter((b) => b.issue_type === "epic")
    .map((epic) => ({ bead: epic, under: descendantsOf(epic.id, beads).filter((b) => offeredIds.has(b.id)) }))
    .filter((choice) => choice.under.length > 0);
  return [...epics, ...offered.map((bead) => ({ bead, under: null }))].sort((a, b) => newestFirst(a.bead, b.bead));
}

function PickerBody(props: {
  sprint: Sprint;
  beads: AllBead[];
  projects: ProjectSummary[];
  onClose: () => void;
}) {
  const { sprint, beads, projects, onClose } = props;
  const { add, busy } = useAddToSprint();
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");
  const [failure, setFailure] = React.useState<string | null>(null);

  const choices = React.useMemo(() => choicesOf(beads), [beads]);
  const bd = React.useMemo(() => new Set(projects.filter((p) => p.kind === "bd").map((p) => p.id)), [projects]);
  const shown = choices.filter((choice) => matchesBacklogFilters(choice.bead, chosen, search));
  // Read from the list as it is now: a bead that went into a sprint meanwhile is no choice any more.
  const picked = choices.filter((choice) => choice.under === null && ticked.has(choice.bead.id)).map((choice) => choice.bead);

  const tick = (ids: string[], on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function confirm() {
    setFailure(null);
    const refused = await add(picked, sprint.id);
    if (refused.length === 0) {
      onClose();
      return;
    }
    setTicked(new Set(refused.map((r) => r.bead.id)));
    setFailure(`${refused.length} of ${plural(picked.length, "bead")} could not be added: ${refused[0].reason}`);
  }

  function boxOf(choice: Choice) {
    const own = displayId(choice.bead);
    const locked = busy || bd.has(choice.bead.project.id);
    if (choice.under === null) {
      return (
        <Checkbox
          aria-label={`Select ${own} of ${choice.bead.project.name}`}
          checked={ticked.has(choice.bead.id)}
          disabled={locked}
          onCheckedChange={(on) => tick([choice.bead.id], on)}
        />
      );
    }
    const ids = choice.under.map((b) => b.id);
    const count = ids.filter((id) => ticked.has(id)).length;
    const all = count === ids.length;
    return (
      <Checkbox
        aria-label={`Select every bead under ${own} of ${choice.bead.project.name}`}
        checked={all}
        indeterminate={count > 0 && !all}
        disabled={locked}
        onCheckedChange={() => tick(ids, !all)}
        className="data-indeterminate:border-primary data-indeterminate:bg-primary/50 data-indeterminate:text-primary-foreground"
      />
    );
  }

  const trailOf = (choice: Choice) => {
    if (bd.has(choice.bead.project.id)) return BD_NOTE;
    return choice.under ? plural(choice.under.length, "bead") : undefined;
  };

  return (
    <>
      <DialogTitle>Add beads to {sprint.name}</DialogTitle>
      <DialogDescription>
        The open work of every project that is in no sprint. Choosing an epic chooses every bead under it.
      </DialogDescription>
      <BacklogFilters
        projects={projects}
        chosen={chosen}
        onToggle={(id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
        search={search}
        onSearch={setSearch}
      />
      {shown.length === 0 ? (
        <p className="text-[var(--text-3)]">No open bead outside every sprint matches.</p>
      ) : (
        <ul data-testid="picker-rows" className="flex max-h-[52vh] flex-col gap-[5px] overflow-y-auto pr-1">
          {shown.map((choice) => (
            <SprintBeadRow key={choice.bead.id} bead={choice.bead} actions={null} lead={boxOf(choice)} trail={trailOf(choice)} />
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={secondaryButton}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || picked.length === 0}
          onClick={confirm}
          className={primaryButton}
          style={{ background: "var(--brand)" }}
        >
          {busy ? "Adding…" : `Add ${picked.length}`}
        </button>
      </div>
    </>
  );
}

/** Several beads chosen at once for one sprint, from the open work of every project. */
export function SprintBeadPicker(props: {
  /** The sprint to add to; null keeps the dialog closed. */
  sprint: Sprint | null;
  beads: AllBead[];
  projects: ProjectSummary[];
  onClose: () => void;
}) {
  const { sprint, onClose } = props;
  return (
    <Dialog open={sprint !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        {/* Mounted per opening, so a choice made for one sprint is never offered to the next. */}
        {sprint && <PickerBody key={sprint.id} sprint={sprint} beads={props.beads} projects={props.projects} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
