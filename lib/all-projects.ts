import "server-only";
import { getStore } from "./store";
import { subscribeBeadsChange } from "./beads-watch";
import { namespaceBead } from "./aggregate";
import type {
  AllBead,
  FailedProject,
  ProjectRef,
  ProjectSummary,
  TrackerKind,
} from "./aggregate";
import type { Bead } from "./schema";

/** One slow project must not hold the whole board back. */
export const PROJECT_READ_LIMIT_MS = 15_000;

export const TIMED_OUT = "timed out";

export interface ProjectRead {
  kind: TrackerKind;
  beads: Bead[];
}

export type ProjectReader = (project: ProjectRef) => Promise<ProjectRead>;

export interface AllProjectsRead {
  beads: AllBead[];
  projects: ProjectSummary[];
  failed: FailedProject[];
}

export async function readProjectFromStore(project: ProjectRef): Promise<ProjectRead> {
  const store = await getStore(project.id);
  if (store.kind === "demo") throw new Error("the demo project is not a tracker");
  return { kind: store.kind, beads: await store.list() };
}

function failureText(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(err ?? "");
  return text.trim() || "unreadable";
}

function withLimit<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), limitMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type Outcome =
  | { project: ProjectRef; read: ProjectRead }
  | { project: ProjectRef; error: string };

async function readOne(
  project: ProjectRef,
  read: ProjectReader,
  limitMs: number,
): Promise<Outcome> {
  try {
    return { project, read: await withLimit(read(project), limitMs) };
  } catch (err) {
    return { project, error: failureText(err) };
  }
}

/**
 * Reads every project at once. A project that throws or runs past `limitMs`
 * is reported in `failed` and the others are still returned.
 */
export async function readAllProjects(
  projects: ProjectRef[],
  read: ProjectReader = readProjectFromStore,
  limitMs: number = PROJECT_READ_LIMIT_MS,
): Promise<AllProjectsRead> {
  const outcomes = await Promise.all(projects.map((p) => readOne(p, read, limitMs)));
  const result: AllProjectsRead = { beads: [], projects: [], failed: [] };
  for (const outcome of outcomes) {
    const { id, name } = outcome.project;
    if ("error" in outcome) {
      result.failed.push({ id, name, error: outcome.error });
      continue;
    }
    const { kind, beads } = outcome.read;
    result.projects.push({ id, name, kind, count: beads.length });
    for (const bead of beads) result.beads.push(namespaceBead({ id, name }, bead));
  }
  return result;
}

/** Subscribes to every given project; the returned function drops all of them. */
export function subscribeAllBeadsChange(
  projectIds: string[],
  onChange: () => void,
): () => void {
  const unsubscribers = projectIds.map((id) => subscribeBeadsChange(id, onChange));
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
