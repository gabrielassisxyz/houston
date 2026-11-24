import "server-only";
import type { Bead, CreateInput, UpdateInput, DepType } from "./schema";
import { getProject, touchProject, DEMO_PROJECT, ConfigError } from "./config";
import { createBdStore, isBdAvailable } from "./bd";
import { createBrStore, isBrAvailable, isBrProject } from "./br";
import { demoStore } from "./demo-store";

/**
 * Storage abstraction. Three implementations:
 *  - BdStore  → shells out to the `bd` CLI (source of truth).
 *  - BrStore  → reads a `br` (beads_rust) tracker; read-only for now.
 *  - DemoStore → in-memory, seeded from the design export, so the app runs and
 *    is demoable even where bd isn't installed.
 */
export interface DoctorInfo {
  kind: "bd" | "br" | "demo";
  ok: boolean;
  version?: string;
  repoPath: string;
  message: string;
}

export interface BeadsStore {
  kind: "bd" | "br" | "demo";
  list(): Promise<Bead[]>;
  get(id: string): Promise<Bead | null>;
  create(input: CreateInput, actor: string): Promise<Bead>;
  update(id: string, patch: UpdateInput, actor: string): Promise<Bead>;
  /**
   * `reason` is only meaningful when closing — bd records it via
   * `bd close --reason`, and there is no way to attach one after the fact.
   */
  setStatus(id: string, status: string, actor: string, reason?: string): Promise<Bead>;
  remove(id: string, actor: string): Promise<void>;
  addComment(id: string, text: string, actor: string): Promise<Bead>;
  addDep(id: string, dependsOnId: string, type: DepType, actor: string): Promise<Bead>;
  removeDep(id: string, dependsOnId: string, actor: string): Promise<Bead>;
  /** Create a human approval gate that blocks `blocks` (`bd gate create --type human`). */
  createGate(blocks: string, reason: string | undefined, actor: string): Promise<Bead>;
  removeLabel(id: string, label: string, actor: string): Promise<Bead>;
  /**
   * Add and remove single labels without sending the whole set, so a label written
   * elsewhere in the meantime is never overwritten. Resolves to the bead as stored.
   */
  editLabels(id: string, edit: { add: string[]; remove: string[] }, actor: string): Promise<Bead>;
  archive(id: string, actor: string): Promise<Bead>;
  doctor(): Promise<DoctorInfo>;
}

// One store per project id. Demo always maps to the shared in-memory store.
const stores = new Map<string, BeadsStore>();

export async function getStore(projectId: string): Promise<BeadsStore> {
  if (projectId === DEMO_PROJECT.id) return demoStore;

  const cached = stores.get(projectId);
  if (cached) return cached;

  const project = getProject(projectId);
  if (!project || project.path === null) {
    throw new ConfigError(`Unknown project: ${projectId}`, "unknown_project");
  }
  // The tracker kind is decided from the folder, before any binary is probed,
  // so a machine with no `bd` still opens a br project.
  if (isBrProject(project.path)) {
    if (!(await isBrAvailable(project.path))) {
      throw new ConfigError(
        `br is not available for "${project.name}" (${project.path}). ` +
          `Check that br is installed and BR_BIN points at it.`,
        "bd_unavailable",
      );
    }
    const brStore = createBrStore(project.path);
    stores.set(projectId, brStore);
    touchProject(projectId);
    return brStore;
  }
  if (!(await isBdAvailable(project.path))) {
    throw new ConfigError(
      `bd is not available for "${project.name}" (${project.path}). ` +
        `Check that bd is installed and the folder still contains a .beads directory.`,
      "bd_unavailable",
    );
  }
  const store = createBdStore(project.path);
  stores.set(projectId, store);
  // First resolution this session — record that the project was opened.
  touchProject(projectId);
  return store;
}

/** Reset cached store(s) — one project, or all when no id is given. */
export function resetStore(projectId?: string) {
  if (projectId) stores.delete(projectId);
  else stores.clear();
}
