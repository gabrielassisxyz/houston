import type { Metadata } from "next";
import { WorkShell } from "@/components/work-shell";
import { projectTitle } from "@/lib/app-title";

export const metadata: Metadata = { title: projectTitle("Trabalho") };

export default function WorkPage() {
  return <WorkShell />;
}
