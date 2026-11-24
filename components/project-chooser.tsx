"use client";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/icons";
import { typeLabel } from "@/lib/beads-view";
import type { BeadType } from "@/lib/schema";

export interface ProjectChoice {
  id: string;
  /** The project's name, with its id when another project has the same name. */
  label: string;
}

/**
 * The step before the create form on a page over several projects. The form uploads an image to
 * its project before the bead exists, so the project is chosen here, before the form is mounted,
 * and nothing in the form can change it afterwards.
 */
export function ProjectChooser({
  choices,
  type,
  onChooseAction,
  onCloseAction,
}: {
  choices: ProjectChoice[];
  type?: BeadType;
  onChooseAction: (projectId: string) => void;
  onCloseAction: () => void;
}) {
  const title = type ? `New ${typeLabel(type).toLowerCase()}` : "New bead";
  return (
    <Dialog open onOpenChange={(next) => !next && onCloseAction()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[80vh] w-[440px] max-w-[96vw] flex-col gap-0 overflow-hidden rounded-2xl border border-border bg-[var(--surface)] p-0 shadow-[var(--shadow-lg)]"
      >
        <div className="flex shrink-0 items-center gap-[10px] border-b border-border p-[17px_20px]">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--brand-weak)] text-[var(--brand)]">
            <Icon name="plus" size={16} />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-[15px] font-[650]">{title}</DialogTitle>
            <DialogDescription className="text-[12px] text-[var(--text-3)]">
              Which project is it for?
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={onCloseAction}
            aria-label="Close"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="bd-scroll flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto p-4">
          {choices.length === 0 ? (
            <p className="m-0 p-2 text-[13px] text-[var(--text-2)]">
              No project could be read, so there is none to create it in.
            </p>
          ) : (
            choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                value={choice.id}
                onClick={() => onChooseAction(choice.id)}
                className="flex h-[38px] items-center rounded-[9px] border border-border bg-[var(--surface-2)] px-3 text-left text-[13.5px] font-[550] text-[var(--text)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
              >
                {choice.label}
              </button>
            ))
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border p-[15px_20px]">
          <button
            type="button"
            onClick={onCloseAction}
            className="h-[38px] rounded-[9px] border border-border bg-[var(--surface-2)] px-4 text-[13px] font-[550] text-[var(--text)] hover:bg-[var(--surface-3)]"
          >
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
