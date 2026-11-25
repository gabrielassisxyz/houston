import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

const headers = { "Cache-Control": "no-store" };

export function GET() {
  const { workDashboardUrl, snapshotPath, notesServiceUrl, obsidianVault } = getConfig();
  // The notes service's address stays on the server: a page only learns that
  // there is one.
  return NextResponse.json(
    {
      workDashboardUrl: workDashboardUrl ?? null,
      chain: typeof snapshotPath === "string",
      notes: typeof notesServiceUrl === "string",
      obsidianVault: obsidianVault ?? null,
    },
    { headers },
  );
}
