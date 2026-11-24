"use client";

import * as React from "react";
import { useApp } from "@/components/app-context";
import { useUrlState } from "@/hooks/use-url-state";
import {
  doneWindowToWrite,
  isInDoneWindow,
  readDoneWindow,
  type DoneWindow,
} from "@/lib/done-window";
import type { Bead } from "@/lib/schema";

/** The Done window shared by the board and the list: the `done` parameter over the page's default. */
export function useDoneWindow() {
  const { doneWindowDefault } = useApp();
  const fallback: DoneWindow = doneWindowDefault ?? "all";
  const { searchParams, updateUrl } = useUrlState();
  const doneWindow = readDoneWindow(searchParams.get("done"), fallback);
  // Mount-time "now", captured once: the window is day-granular, so it needn't tick, and
  // keeping the clock out of render satisfies the no-impure-call rule.
  const [now] = React.useState(() => Date.now());

  const setDoneWindow = React.useCallback(
    (choice: DoneWindow) => {
      updateUrl((params) => {
        const written = doneWindowToWrite(choice, fallback);
        if (written === null) params.delete("done");
        else params.set("done", written);
      });
    },
    [updateUrl, fallback],
  );
  const inWindow = React.useCallback(
    (bead: Bead) => isInDoneWindow(bead, doneWindow, now),
    [doneWindow, now],
  );

  return { doneWindow, setDoneWindow, inWindow };
}
