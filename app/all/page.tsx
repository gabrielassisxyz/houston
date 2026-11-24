import { Suspense } from "react";
import type { Metadata } from "next";
import { AllProjectsShell } from "@/components/all-projects-shell";
import { projectTitle } from "@/lib/app-title";

export const metadata: Metadata = { title: projectTitle("All projects") };

export default function AllProjectsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm">Loading projects…</div>}>
      <AllProjectsShell />
    </Suspense>
  );
}
