import { Suspense } from "react";
import type { Metadata } from "next";
import { SprintDetail } from "@/components/sprints/sprint-detail";
import { projectTitle } from "@/lib/app-title";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: projectTitle(`Sprint ${id}`) };
}

export default async function SprintPage({ params }: Props) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="p-6 text-sm">Loading sprint…</div>}>
      <SprintDetail sprintId={id} />
    </Suspense>
  );
}
