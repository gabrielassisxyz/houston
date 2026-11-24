import "server-only";
import type { Bead } from "./schema";
import { getProject } from "./config";
import { getStore } from "./store";
import { readInteractions, type RawInteraction } from "./interactions";
import { readBrEvents } from "./br-events";

/**
 * The one place that knows where a project's status history comes from:
 * `interactions.jsonl` for bd, `br audit log` for br, nothing for the demo.
 */
export async function projectEvents(projectId: string, beads: Bead[]): Promise<RawInteraction[]> {
  const project = getProject(projectId);
  const repoPath = project && "path" in project ? project.path : null;
  if (!repoPath) return [];
  const { kind } = await getStore(projectId);
  if (kind === "br") return readBrEvents(repoPath, beads);
  if (kind === "bd") return readInteractions(repoPath);
  return [];
}
