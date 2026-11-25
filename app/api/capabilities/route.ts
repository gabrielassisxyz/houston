import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

const headers = { "Cache-Control": "no-store" };

export function GET() {
  const { workDashboardUrl } = getConfig();
  return NextResponse.json({ workDashboardUrl: workDashboardUrl ?? null }, { headers });
}
