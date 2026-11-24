import { getConfig, isReadOnly, listProjects } from "@/lib/config";
import { readAllProjects } from "@/lib/all-projects";
import type { AllBeadsResponse } from "@/lib/aggregate";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * The beads of every registered project in one list. A project that cannot be
 * read is named in `meta.failed`; the answer is still 200 for the others.
 */
export async function GET(req: Request) {
  try {
    const cfg = getConfig();
    const read = await readAllProjects(listProjects());
    const body: AllBeadsResponse = {
      beads: read.beads,
      meta: {
        kind: "all",
        readOnly: isReadOnly(req),
        humanActor: cfg.humanActor,
        humanAllowlist: cfg.humanAllowlist,
        pollIntervalMs: cfg.pollIntervalMs,
        projects: read.projects,
        failed: read.failed,
      },
    };
    return ok(body);
  } catch (e) {
    return fail(e);
  }
}
