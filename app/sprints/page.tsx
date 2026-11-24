import { Suspense } from "react";
import type { Metadata } from "next";
import { SprintsShell } from "@/components/sprints/sprints-shell";
import { projectTitle } from "@/lib/app-title";

export const metadata: Metadata = { title: projectTitle("Sprints") };

export default function SprintsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm">Loading sprints…</div>}>
      <SprintsShell />
    </Suspense>
  );
}
