import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchShell } from "@/components/search-shell";
import { projectTitle } from "@/lib/app-title";

export const metadata: Metadata = { title: projectTitle("Busca") };

export default function SearchPage() {
  return (
    <Suspense fallback={<p lang="pt-BR">Carregando a busca…</p>}>
      <SearchShell />
    </Suspense>
  );
}
