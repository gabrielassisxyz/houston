import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  createSprintSchema,
  patchSprintSchema,
  sprintsFileSchema,
  type Sprint,
} from "./sprint-model";

/**
 * A refusal a sprint route answers as it is: `code` and the message go in the body, `status`
 * is the HTTP status. Later sprint actions raise their own codes through the same class.
 */
export class SprintError extends Error {
  constructor(public code: string, public status: number, message: string, public file?: string) {
    super(message);
    this.name = "SprintError";
  }
}

/** The HTTP answer for a sprint refusal, in the `{error, code}` shape of lib/api.ts; null for any other error. */
export function sprintFailure(err: unknown): { status: number; body: { error: string; code: string } } | null {
  if (!(err instanceof SprintError)) return null;
  return { status: err.status, body: { error: err.message, code: err.code } };
}

// Same two lines as lib/config.ts: that function is private and the sprint file lives beside
// config.json without sharing its cache or its write path.
function defaultFile(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "houston", "sprints.json");
}

export function createSprintStore(file: string = defaultFile()) {
  // Nothing is cached: every read parses the file again, so a sprint written by another
  // process is seen by the next call. A damaged file is reported and never replaced.
  function read(): Sprint[] {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new SprintError("sprints_file_invalid", 500, `Cannot read the sprints file ${file}: ${(e as Error).message}`, file);
    }
    try {
      return sprintsFileSchema.parse(JSON.parse(text)).sprints as Sprint[];
    } catch (e) {
      const why = e instanceof ZodError ? "it does not match the expected shape" : "it is not valid JSON";
      throw new SprintError("sprints_file_invalid", 500, `The sprints file ${file} is damaged: ${why}. Fix or remove it by hand.`, file);
    }
  }

  // Temp file in the same directory, renamed over the real one: a crash leaves either the old
  // file or the new one, never half of one.
  function write(sprints: Sprint[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, sprints }, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  // One chain for the process; each step re-reads the file, so two writers arriving together
  // both land instead of the second overwriting the first.
  let chain: Promise<unknown> = Promise.resolve();
  function serialised<T>(step: () => T): Promise<T> {
    const run = chain.then(step, step);
    chain = run.catch(() => undefined);
    return run;
  }

  function find(sprints: Sprint[], id: string): Sprint {
    const found = sprints.find((s) => s.id === id);
    if (!found) throw new SprintError("unknown_sprint", 404, `No sprint ${id}`);
    return found;
  }

  async function list(): Promise<Sprint[]> {
    return read().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  async function get(id: string): Promise<Sprint> {
    return find(read(), id);
  }

  async function create(input: unknown): Promise<Sprint> {
    const parsed = createSprintSchema.parse(input);
    return serialised(() => {
      const sprints = read();
      if (sprints.some((s) => s.id === parsed.start)) {
        throw new SprintError("sprint_exists", 409, `A sprint already starts on ${parsed.start}`);
      }
      const sprint: Sprint = {
        id: parsed.start,
        name: parsed.name,
        start: parsed.start,
        end: parsed.end,
        capacity: parsed.capacity,
        state: "planned",
        createdAt: new Date().toISOString(),
        startedAt: null,
        closedAt: null,
        planned: null,
        unreadableAtStart: [],
        summary: null,
        pending: [],
      };
      write([...sprints, sprint]);
      return sprint;
    });
  }

  // Read, change and write as one step. `fn` also sees every sprint as the file holds it at
  // that moment, so a rule about the other sprints is checked when the record changes and not
  // some time before.
  function mutate(id: string, fn: (sprint: Sprint, all: readonly Sprint[]) => Sprint): Promise<Sprint> {
    return serialised(() => {
      const sprints = read();
      const current = find(sprints, id);
      const next = fn(structuredClone(current), sprints);
      if (next.id !== id) throw new Error("A sprint id never changes");
      write(sprints.map((s) => (s.id === id ? next : s)));
      return next;
    });
  }

  async function patch(id: string, input: unknown): Promise<Sprint> {
    const parsed = patchSprintSchema.parse(input);
    return mutate(id, (sprint) => {
      if (sprint.state === "closing" || sprint.state === "closed") {
        throw new SprintError("sprint_not_editable", 409, `Sprint ${id} is ${sprint.state} and cannot be edited`);
      }
      const next = { ...sprint, ...parsed };
      if (next.end < sprint.start) {
        throw new ZodError([{ code: "custom", path: ["end"], message: "must be on or after start", input: parsed.end }]);
      }
      return next;
    });
  }

  function remove(id: string): Promise<void> {
    return serialised(() => {
      const sprints = read();
      const sprint = find(sprints, id);
      if (sprint.state !== "planned") {
        throw new SprintError("sprint_not_deletable", 409, `Sprint ${id} is ${sprint.state}; only a planned sprint can be deleted`);
      }
      write(sprints.filter((s) => s.id !== id));
    });
  }

  return { list, get, create, patch, remove, mutate, file };
}

export const sprintStore = createSprintStore();
