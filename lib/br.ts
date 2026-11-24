import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beadSchema, unwrapEnvelope, type Bead, type CreateInput, type DepType, type UpdateInput } from "./schema";
import { BdError } from "./bd";
import type { BeadsStore, DoctorInfo } from "./store";

/**
 * Store over a `br` (beads_rust) tracker.
 *
 * `list()` parses `.beads/issues.jsonl` directly instead of calling `br list`,
 * because `br list --json` carries neither dependency edges nor the parent,
 * while the JSONL is br's own interchange file and has edges, labels and
 * comments in the flat shape the schema accepts. br replaces that file
 * atomically after every write. Known limit: a bead written with
 * `--no-auto-flush` stays invisible until the next flush.
 *
 * `get()` runs `br show <id> --json`. Mutations call the matching `br` verb with the
 * global `--actor` flag; only `createGate` has no `br` equivalent. Only delete is forced:
 * br's refusal to start or close a blocked bead is shown to the user as it is.
 */

const pExecFile = promisify(execFile);
const BR_BIN = process.env.BR_BIN || "br";

/** True when `.beads/` was created by br: a SQLite db and no embedded Dolt store. */
export function isBrProject(repoPath: string): boolean {
  const beads = path.join(repoPath, ".beads");
  return fs.existsSync(path.join(beads, "beads.db")) && !fs.existsSync(path.join(beads, "embeddeddolt"));
}

const availabilityCache = new Map<string, boolean>();

export async function isBrAvailable(repoPath: string): Promise<boolean> {
  const hit = availabilityCache.get(repoPath);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    await pExecFile(BR_BIN, ["--version"], { timeout: 5000 });
    ok = true;
  } catch {
    ok = false;
  }
  availabilityCache.set(repoPath, ok);
  return ok;
}

/** br prints `{"error": {"code", "message"}}`; bd prints a string, so read both shapes. */
function toBdError(stderr: string, stdout: string, fallback: string): BdError {
  // `br close` on a blocked bead prints a result object and then the error object on stdout,
  // so besides each channel whole, try every suffix that starts at a line beginning with `{`.
  const channels = [stderr.trim(), stdout.trim()].flatMap((text) => [
    text,
    ...[...text.matchAll(/\n(?=\{)/g)].map((m) => text.slice(m.index + 1)),
  ]);
  for (const text of channels) {
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } | string };
      const err = parsed.error;
      if (err && typeof err === "object") {
        const code = err.code === "ISSUE_NOT_FOUND" ? "not_found" : err.code;
        return new BdError(err.message || fallback, code);
      }
      if (typeof err === "string") return new BdError(err);
    } catch {
      /* not JSON, try the next channel */
    }
  }
  return new BdError(stderr.trim() || fallback);
}

/**
 * br ignores BEADS_ACTOR; the acting user travels as the global `--actor` flag.
 *
 * `--json` goes before the verb, not after its arguments: a verb whose free text follows a
 * `--` separator would otherwise swallow a trailing `--json` as part of that text.
 *
 * Text a person typed never travels as a bare argument. br rejects a positional or a separate
 * option value that starts with a hyphen ("unexpected argument"), and a markdown bullet or a
 * title like "-v flag is ignored" does. Options carry it as `--name=value`, positionals follow
 * a `--`.
 */
async function runBr(args: string[], repoPath: string, actor?: string): Promise<string> {
  const full = [...(actor ? ["--actor", actor] : []), "--json", ...args];
  try {
    const { stdout } = await pExecFile(BR_BIN, full, { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw toBdError(e.stderr || "", e.stdout || "", e.message || "br command failed");
  }
}

async function runBrJson(args: string[], repoPath: string, actor?: string): Promise<unknown> {
  const stdout = await runBr(args, repoPath, actor);
  try {
    return unwrapEnvelope(JSON.parse(stdout));
  } catch (err: unknown) {
    throw new BdError(`br output was not JSON: ${(err as Error).message}`, "parse_error");
  }
}

/** br numbers comment ids; the shared schema wants strings. */
function normalizeComments(obj: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(obj.comments)) return obj;
  const comments = obj.comments.map((c) =>
    c && typeof c === "object" && "id" in c ? { ...c, id: String((c as { id: unknown }).id) } : c,
  );
  return { ...obj, comments };
}

function parseBead(raw: unknown): Bead | { error: string } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const parsed = beadSchema.safeParse(normalizeComments(obj));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return { error: `${issue.path.join(".")}: ${issue.message}` };
}

/** Parse the JSONL export: skip tombstones, log (never silently drop) invalid rows. */
function parseJsonl(jsonl: string): Bead[] {
  const beads: Bead[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj as { status?: unknown }).status === "tombstone") continue;
    const bead = parseBead(obj);
    if ("error" in bead) {
      const id = (obj as { id?: unknown })?.id;
      console.error(`[br] skipping bead ${typeof id === "string" ? id : "(no id)"}: ${bead.error}`);
      continue;
    }
    beads.push(bead);
  }
  return beads;
}

const unsupported = (op: string) => () =>
  Promise.reject(new BdError(`${op} is not supported yet on br-tracked projects`, "unsupported"));

/** Flags of `br update` for the fields a patch carries. Empty when it carries none. */
function updateArgs(patch: UpdateInput): string[] {
  const args: string[] = [];
  if (patch.title !== undefined) args.push(`--title=${patch.title}`);
  if (patch.description !== undefined) args.push(`--description=${patch.description}`);
  if (patch.status !== undefined && patch.status !== "closed") args.push(`--status=${patch.status}`);
  if (patch.priority !== undefined) args.push(`--priority=${patch.priority}`);
  if (patch.issue_type !== undefined) args.push(`--type=${patch.issue_type}`);
  if (patch.assignee !== undefined) args.push(`--assignee=${patch.assignee}`);
  // An empty value detaches the parent, so test against undefined, not truthiness.
  if (patch.parent !== undefined) args.push(`--parent=${patch.parent}`);
  // An empty value clears every label on br.
  if (patch.labels !== undefined) args.push(`--set-labels=${patch.labels.join(",")}`);
  return args;
}

export function createBrStore(repoPath: string): BeadsStore {
  // Collapse concurrent list() callers (the polling views) onto one read.
  let inflightList: Promise<Bead[]> | null = null;

  async function show(id: string): Promise<Bead> {
    const bead = await store.get(id);
    if (!bead) throw new BdError(`bead ${id} not found`, "not_found");
    return bead;
  }

  const store: BeadsStore = {
    kind: "br",

    async list() {
      if (inflightList) return inflightList;
      inflightList = fs.promises
        .readFile(path.join(repoPath, ".beads", "issues.jsonl"), "utf8")
        .then(parseJsonl);
      try {
        return await inflightList;
      } finally {
        inflightList = null;
      }
    },

    async get(id) {
      try {
        const data = await runBrJson(["show", "--", id], repoPath);
        const rec = Array.isArray(data) ? data[0] : data;
        if (!rec) return null;
        const bead = parseBead(rec);
        if ("error" in bead) {
          throw new BdError(`could not parse bead ${id}: ${bead.error}`, "parse_error");
        }
        // `br show` still answers for a deleted bead, with the tombstone it keeps for sync.
        if (bead.status === "tombstone") return null;
        return bead;
      } catch (e) {
        if (e instanceof BdError && e.code === "not_found") return null;
        throw e;
      }
    },

    async create(input: CreateInput, actor: string) {
      const args = ["create", `--type=${input.issue_type}`, `--priority=${input.priority}`];
      if (input.description) args.push(`--description=${input.description}`);
      if (input.assignee) args.push(`--assignee=${input.assignee}`);
      if (input.labels?.length) args.push(`--labels=${input.labels.join(",")}`);
      if (input.parent) args.push(`--parent=${input.parent}`);
      args.push("--", input.title);
      const created = (await runBrJson(args, repoPath, actor)) as { id: string };
      if (input.backlog) await runBr(["update", "--status=deferred", "--", created.id], repoPath, actor);
      return show(created.id);
    },

    async update(id, patch: UpdateInput, actor) {
      const args = updateArgs(patch);
      if (args.length) await runBr(["update", ...args, "--", id], repoPath, actor);
      if (patch.status === "closed") await runBr(["close", "--", id], repoPath, actor);
      return show(id);
    },

    async setStatus(id, status, actor, reason) {
      if (status === "closed") {
        const trimmed = reason?.trim();
        await runBr(["close", ...(trimmed ? [`--reason=${trimmed}`] : []), "--", id], repoPath, actor);
      } else {
        await runBr(["update", `--status=${status}`, "--", id], repoPath, actor);
      }
      return show(id);
    },

    async remove(id, actor) {
      await runBr(["delete", "--force", "--", id], repoPath, actor);
    },

    async addComment(id, text, actor) {
      await runBr(["comments", "add", "--", id, text], repoPath, actor);
      return show(id);
    },

    async addDep(id, dependsOnId, type: DepType, actor) {
      await runBr(["dep", "add", `--type=${type}`, "--", id, dependsOnId], repoPath, actor);
      return show(id);
    },

    async removeDep(id, dependsOnId, actor) {
      await runBr(["dep", "remove", "--", id, dependsOnId], repoPath, actor);
      return show(id);
    },

    createGate: unsupported("createGate"),

    async removeLabel(id, label, actor) {
      await runBr(["update", `--remove-label=${label}`, "--", id], repoPath, actor);
      return show(id);
    },

    async editLabels(id, { add, remove }, actor) {
      // One command with single-label flags, never --set-labels: br applies them to what the
      // tracker holds now, so a label added from a terminal a moment ago survives.
      const flags = [...add.map((l) => `--add-label=${l}`), ...remove.map((l) => `--remove-label=${l}`)];
      await runBr(["update", ...flags, "--", id], repoPath, actor);
      return show(id);
    },

    async archive(id, actor) {
      // Archiving is offered on cards that are already done, and br refuses to close a closed
      // bead ("already closed", exit 3) where bd lets it pass.
      const current = await show(id);
      if (current.status !== "closed") await runBr(["close", "--", id], repoPath, actor);
      await runBr(["label", "add", "--", id, "archived"], repoPath, actor);
      return show(id);
    },

    async doctor(): Promise<DoctorInfo> {
      try {
        const { stdout } = await pExecFile(BR_BIN, ["--version"], { cwd: repoPath, timeout: 5000 });
        return {
          kind: "br",
          ok: true,
          version: stdout.trim(),
          repoPath,
          message: `Connected to br at ${repoPath}`,
        };
      } catch (e) {
        return { kind: "br", ok: false, repoPath, message: (e as Error).message };
      }
    },
  };
  return store;
}
