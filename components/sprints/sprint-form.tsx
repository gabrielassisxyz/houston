"use client";
import * as React from "react";
import { ApiError } from "@/lib/api-client";
import {
  createSprintSchema,
  type CreateSprintInput,
  type PatchSprintInput,
  type Sprint,
} from "@/lib/sprint-model";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toastError } from "@/components/error-toast";
import { useCreateSprint, useUpdateSprint } from "@/hooks/use-sprints";

const inputClass =
  "h-[38px] rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-[12.5px] text-[var(--text)] outline-none focus:border-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-60";

type Field = "name" | "start" | "end" | "capacity";
type Errors = Partial<Record<Field | "form", string>>;

interface Draft {
  name: string;
  start: string;
  end: string;
  capacity: string;
}

function draftOf(sprint: Sprint | null): Draft {
  if (!sprint) return { name: "", start: "", end: "", capacity: "" };
  return { name: sprint.name, start: sprint.start, end: sprint.end, capacity: String(sprint.capacity) };
}

// The capacity field is text so that "1.5" and "" reach the check instead of being coerced away.
function parseCapacity(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** The same rules the server applies, as one message per field. */
function check(draft: Draft): { input?: CreateSprintInput; errors: Errors } {
  const result = createSprintSchema.safeParse({
    name: draft.name,
    start: draft.start,
    end: draft.end,
    capacity: parseCapacity(draft.capacity),
  });
  if (result.success) return { input: result.data, errors: {} };
  const errors: Errors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as Field | undefined;
    if (!field || errors[field]) continue;
    errors[field] = messageFor(field, issue.message);
  }
  return { errors };
}

function messageFor(field: Field, raw: string): string {
  if (field === "name") return "Give the sprint a name of 1 to 80 characters";
  if (field === "capacity") return "Capacity is a whole number from 0 to 9999";
  if (field === "end" && raw === "must be on or after start") return "The end date cannot be before the start date";
  return "Pick a real date";
}

/** Only what differs from the stored sprint: the server rejects an empty patch and a start. */
function changesOf(sprint: Sprint, input: CreateSprintInput): PatchSprintInput {
  const patch: PatchSprintInput = {};
  if (input.name !== sprint.name) patch.name = input.name;
  if (input.end !== sprint.end) patch.end = input.end;
  if (input.capacity !== sprint.capacity) patch.capacity = input.capacity;
  return patch;
}

function FieldBox(props: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] text-[var(--text-2)]">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[11px] text-[var(--text-3)]">{props.hint}</span>}
      {props.error && (
        <span role="alert" className="text-[11.5px] text-destructive">
          {props.error}
        </span>
      )}
    </label>
  );
}

interface SprintFormProps {
  /** The sprint being corrected, or null to create one. */
  sprint: Sprint | null;
  open: boolean;
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SprintForm({ sprint, open, readOnly, onOpenChange }: SprintFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Remounted per opening so a closed form never keeps the last draft. */}
        {open && <FormBody sprint={sprint} readOnly={readOnly} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function FormBody({ sprint, readOnly, onDone }: { sprint: Sprint | null; readOnly: boolean; onDone: () => void }) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(sprint));
  const [errors, setErrors] = React.useState<Errors>({});
  const create = useCreateSprint();
  const update = useUpdateSprint();
  const busy = create.isPending || update.isPending;
  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || busy) return;
    const { input, errors: found } = check(draft);
    setErrors(found);
    if (!input) return;
    try {
      if (sprint) {
        const patch = changesOf(sprint, input);
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: sprint.id, patch });
      } else {
        await create.mutateAsync(input);
      }
      onDone();
    } catch (err) {
      // A refusal stays in the form, where the field it is about is still on screen.
      if (err instanceof ApiError && err.status !== 403) setErrors({ form: err.message });
      else toastError(err);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <DialogTitle>{sprint ? "Edit sprint" : "New sprint"}</DialogTitle>
      <DialogDescription>
        {sprint ? "Correct the name, the end date or the capacity." : "A time box that holds beads from any project."}
      </DialogDescription>
      <FieldBox label="Name" error={errors.name}>
        <input aria-label="Name" className={inputClass} value={draft.name} onChange={set("name")} disabled={readOnly} />
      </FieldBox>
      <FieldBox
        label="Start date"
        error={errors.start}
        hint={sprint ? "The start date identifies the sprint, so it cannot be changed." : undefined}
      >
        <input
          aria-label="Start date"
          type="date"
          className={inputClass}
          value={draft.start}
          onChange={set("start")}
          disabled={readOnly || sprint !== null}
        />
      </FieldBox>
      <FieldBox label="End date" error={errors.end}>
        <input aria-label="End date" type="date" className={inputClass} value={draft.end} onChange={set("end")} disabled={readOnly} />
      </FieldBox>
      <FieldBox label="Capacity (points)" error={errors.capacity}>
        <input
          aria-label="Capacity"
          inputMode="decimal"
          className={inputClass}
          value={draft.capacity}
          onChange={set("capacity")}
          disabled={readOnly}
        />
      </FieldBox>
      {errors.form && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {errors.form}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-[36px] rounded-[9px] border border-border px-[14px] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={readOnly || busy}
          className="h-[36px] rounded-[9px] px-[14px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: "var(--brand)" }}
        >
          {sprint ? "Save" : "Create sprint"}
        </button>
      </div>
    </form>
  );
}
