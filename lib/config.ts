import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkObsidianVault } from "./config-values";
import { checkLoopbackServiceUrl } from "./loopback-url";
import { checkWorkDashboardUrl } from "./loopback-url";
import { checkGithubOrgs, checkServiceNowHost, checkSnapshotPath } from "./config-values";

/**
 * Local app config (NOT stored in beads). Lives as a small JSON file under the
 * OS config dir. Holds the human actor used to stamp writes, the human allowlist
 * for origin detection, the poll interval, and the registry of beads projects
 * the app knows about.
 *
 * Project identity is per-request (driven by the /p/<projectId> URL), so the
 * "active" project is NOT stored here — only the durable list of discovered ones.
 */
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  /** ISO timestamps. */
  addedAt: string;
  lastOpened: string;
}

export interface AppConfig {
  humanActor: string;
  humanAllowlist: string[];
  pollIntervalMs: number;
  projects: ProjectEntry[];
  /**
   * Manual board ordering, kept app-local (NOT in beads): projectId → columnId →
   * ordered bead ids. Lets users drag beads within a column to set work order.
   */
  orders: Record<string, Record<string, string[]>>;
  /** Opt-in: show the gamification XP/level layer (off by default). */
  gamification: boolean;
  /**
   * True once the human actor was saved from Settings. Until then the actor
   * follows the computed default, even if an older version wrote it to disk.
   */
  humanActorChosen?: boolean;
  /**
   * Address of the work dashboard page served by the local collector program,
   * framed inside Houston at the route /work. Absent when unset; `null` is
   * never stored or returned.
   */
  workDashboardUrl?: string;
  /**
   * Path of the snapshot file a local collector writes on the work machine.
   * Absent when unset; `null` is never stored or returned.
   */
  snapshotPath?: string;
  /**
   * Bare host name of the ticket instance links may point at. Absent when
   * unset; `null` is never stored or returned.
   */
  serviceNowHost?: string;
  /**
   * Lowercase GitHub owner names pipeline links may be built for. Absent
   * when unset; `null` is never stored or returned. An empty list is stored.
   */
  githubOrgs?: string[];
  /**
   * Root address of the notes service, which only the server calls. Absent
   * when unset; `null` is never stored or returned.
   */
  notesServiceUrl?: string;
  /**
   * Name of the Obsidian vault that holds the notes, as pages need it to open
   * one. Absent when unset; `null` is never stored or returned.
   */
  obsidianVault?: string;
}

/**
 * Patch type for `saveConfig`: `workDashboardUrl`, `snapshotPath`,
 * `serviceNowHost`, `notesServiceUrl` and `obsidianVault` are `string | null`,
 * `githubOrgs` is `string[] | null`, with `null` removing the key.
 */
export interface SaveConfigPatch {
  humanActor?: string;
  humanAllowlist?: string[];
  pollIntervalMs?: number;
  gamification?: boolean;
  workDashboardUrl?: string | null;
  snapshotPath?: string | null;
  serviceNowHost?: string | null;
  githubOrgs?: string[] | null;
  notesServiceUrl?: string | null;
  obsidianVault?: string | null;
}

/**
 * The built-in demo dataset, surfaced as an always-available pseudo-project.
 * It has no filesystem path; the store resolver maps it to the in-memory store.
 */
export const DEMO_PROJECT = {
  id: "demo",
  name: "Demo",
  path: null,
} as const;
export type DemoProject = typeof DEMO_PROJECT;

export class ConfigError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/**
 * SCOTTY_READ_ONLY=1 (or "true") supplies the default for new browser sessions.
 * The session cookie overrides that default when the user changes the mode.
 * In the effective read-only mode, project writes are refused server-side and
 * editing controls are disabled. App settings remain available.
 */
export const VIEWER_MODE_COOKIE = "scotty-viewer-mode";

export function isReadOnly(request?: Request): boolean {
  // This is a browser preference, not an authorization boundary. A session
  // cookie lets one browser override the launch default without affecting others.
  const cookie = request?.headers.get("cookie")?.split(";").map((v) => v.trim())
    .find((v) => v.startsWith(`${VIEWER_MODE_COOKIE}=`))?.slice(VIEWER_MODE_COOKIE.length + 1);
  if (cookie === "read-only") return true;
  if (cookie === "editing") return false;
  const v = process.env.SCOTTY_READ_ONLY;
  return v === "1" || v === "true";
}

/**
 * Focus-view lane chips: SCOTTY_LANE_PREFIX names a label prefix (e.g. "ctx:")
 * whose values partition work into lanes/teams/areas. When set, the Focus view
 * offers one filter chip per lane label found on the visible beads. Unset →
 * no chips (the feature is invisible).
 */
export function lanePrefix(): string | null {
  return process.env.SCOTTY_LANE_PREFIX || null;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "houston");
}
function configFile(): string {
  return path.join(configDir(), "config.json");
}

function osUserName(): string {
  try {
    return os.userInfo().username || "you";
  } catch {
    return "you";
  }
}

/** git's user.name as seen from the launch directory, or null without git or a name. */
function gitUserName(): string | null {
  try {
    const name = execFileSync("git", ["config", "--get", "user.name"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

function defaults(): AppConfig {
  // Same order as bd's own actor (`bd --help`, --actor): BEADS_ACTOR, then git
  // user.name, then the OS user. If Houston stamped writes with the OS name
  // while `bd update --claim` used the git name, bd would refuse to let the UI
  // close beads the user claimed from the CLI.
  const humanActor = process.env.BEADS_ACTOR || gitUserName() || osUserName();
  return {
    humanActor,
    humanAllowlist: [humanActor],
    // Fallback refresh interval. The SSE change stream (see lib/beads-watch)
    // drives fast updates; this interval only backstops a dropped stream.
    pollIntervalMs: 30000,
    projects: [],
    orders: {},
    gamification: false,
  };
}

// ---- helpers -------------------------------------------------------------

function hasBeads(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, ".beads"));
  } catch {
    return false;
  }
}
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function sameDir(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b);
}
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
function makeId(absPath: string, taken: Set<string>): string {
  const base = slug(path.basename(absPath));
  let id = base;
  while (taken.has(id) || id === DEMO_PROJECT.id) {
    id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return id;
}
function makeEntry(inputPath: string, taken: Set<string>): ProjectEntry {
  const abs = path.resolve(inputPath);
  const now = new Date().toISOString();
  return {
    id: makeId(abs, taken),
    name: path.basename(abs) || abs,
    path: abs,
    addedAt: now,
    lastOpened: now,
  };
}

/** Drop malformed registry entries so a bad config file never crashes startup. */
function sanitizeProjects(input: unknown): ProjectEntry[] {
  if (!Array.isArray(input)) return [];
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.path !== "string") continue;
    if (e.id === DEMO_PROJECT.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      path: e.path,
      name: typeof e.name === "string" && e.name ? e.name : path.basename(e.path) || e.path,
      addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
      lastOpened: typeof e.lastOpened === "string" ? e.lastOpened : new Date().toISOString(),
    });
  }
  return out;
}

// ---- load / persist ------------------------------------------------------

let cached: AppConfig | null = null;

/** True only for a plain JSON object: non-null, non-array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Persist the config, preserving any unknown keys already on disk (e.g. the
 * legacy `repoPath`/`demo` fields) so older app versions can still read them.
 * The file is replaced atomically through a UUID-named temporary file of mode
 * `0600` and kept readable by its owner only. Best-effort: a failure is logged
 * and the new value still applies for the session.
 */
function persist(cfg: AppConfig, deleteKeys?: string[]): void {
  cached = cfg;
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    let base: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(configFile(), "utf8"));
      if (isRecord(raw)) base = raw;
      else base = {};
    } catch {
      base = {};
    }
    const next: Record<string, unknown> = { ...base, ...cfg };
    if (deleteKeys) {
      for (const k of deleteKeys) delete next[k];
    }
    const temp = path.join(dir, `${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(temp, configFile());
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* the temp file is already gone */
      }
    }
  } catch (e) {
    console.warn(`[houston] config: could not write config file: ${(e as Error)?.message ?? String(e)}`);
  }
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const d = defaults();

  let onDisk:
    | (Partial<AppConfig> & { repoPath?: string; demo?: boolean })
    | null = null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    onDisk = isRecord(raw) ? (raw as Partial<AppConfig> & { repoPath?: string; demo?: boolean }) : null;
  } catch {
    onDisk = null;
  }

  // Before 0.3.1 the computed default (the OS user) was written to disk along
  // with the first project, so an unchosen OS username on disk is a stale
  // default rather than a preference. Replace it, and keep the new actor in the
  // allowlist so the user's own writes still render as human.
  const staleActor =
    !onDisk?.humanActorChosen && onDisk?.humanActor === osUserName() && d.humanActor !== onDisk.humanActor;
  const storedAllowlist = onDisk?.humanAllowlist && onDisk.humanAllowlist.length ? onDisk.humanAllowlist : null;
  const merged: AppConfig = {
    humanActor: staleActor ? d.humanActor : onDisk?.humanActor || d.humanActor,
    humanAllowlist: !storedAllowlist
      ? d.humanAllowlist
      : staleActor && !storedAllowlist.includes(d.humanActor)
        ? [...storedAllowlist, d.humanActor]
        : storedAllowlist,
    pollIntervalMs:
      typeof onDisk?.pollIntervalMs === "number" ? onDisk.pollIntervalMs : d.pollIntervalMs,
    projects: sanitizeProjects(onDisk?.projects),
    orders:
      onDisk?.orders && typeof onDisk.orders === "object" && !Array.isArray(onDisk.orders)
        ? (onDisk.orders as Record<string, Record<string, string[]>>)
        : {},
    gamification: typeof onDisk?.gamification === "boolean" ? onDisk.gamification : d.gamification,
    humanActorChosen: onDisk?.humanActorChosen === true,
  };

  if (onDisk && onDisk.workDashboardUrl !== undefined) {
    const checked = checkWorkDashboardUrl(onDisk.workDashboardUrl);
    if (checked.ok) {
      merged.workDashboardUrl = checked.url;
    } else {
      console.warn(`[houston] config: workDashboardUrl ignored: ${checked.reason}`);
    }
  }

  if (onDisk && (onDisk as Partial<AppConfig>).snapshotPath !== undefined) {
    const checked = checkSnapshotPath((onDisk as Partial<AppConfig>).snapshotPath);
    if (checked.ok) {
      merged.snapshotPath = checked.value;
    } else {
      console.warn(`[houston] config: snapshotPath ignored: ${checked.reason}`);
    }
  }

  if (onDisk && (onDisk as Partial<AppConfig>).serviceNowHost !== undefined) {
    const checked = checkServiceNowHost((onDisk as Partial<AppConfig>).serviceNowHost);
    if (checked.ok) {
      merged.serviceNowHost = checked.value;
    } else {
      console.warn(`[houston] config: serviceNowHost ignored: ${checked.reason}`);
    }
  }

  if (onDisk && (onDisk as Partial<AppConfig>).githubOrgs !== undefined) {
    const checked = checkGithubOrgs((onDisk as Partial<AppConfig>).githubOrgs);
    if (checked.ok) {
      merged.githubOrgs = checked.value;
    } else {
      console.warn(`[houston] config: githubOrgs ignored: ${checked.reason}`);
    }
  }

  if (onDisk && onDisk.notesServiceUrl !== undefined) {
    const checked = checkLoopbackServiceUrl(onDisk.notesServiceUrl);
    if (checked.ok) {
      merged.notesServiceUrl = checked.url;
    } else {
      console.warn(`[houston] config: notesServiceUrl ignored: ${checked.reason}`);
    }
  }

  if (onDisk && onDisk.obsidianVault !== undefined) {
    const checked = checkObsidianVault(onDisk.obsidianVault);
    if (checked.ok) {
      merged.obsidianVault = checked.value;
    } else {
      console.warn(`[houston] config: obsidianVault ignored: ${checked.reason}`);
    }
  }

  // One-time migration: back-fill the registry from the legacy single repoPath
  // (or BEADS_REPO / cwd) when no projects array exists yet.
  let migrated = false;
  if (!onDisk || onDisk.projects === undefined) {
    const legacyPath = onDisk?.repoPath || process.env.BEADS_REPO || process.cwd();
    if (
      legacyPath &&
      hasBeads(legacyPath) &&
      !merged.projects.some((p) => sameDir(p.path, legacyPath))
    ) {
      merged.projects.push(makeEntry(legacyPath, new Set(merged.projects.map((p) => p.id))));
      migrated = true;
    }
  }

  cached = merged;
  // Persist the migrated entry so its id is stable across restarts.
  if (migrated) persist(merged);
  return cached;
}

/**
 * The actor to close a bead as. bd refuses to close a claimed bead as anyone
 * but its assignee. Earlier versions wrote as the OS user, so beads people
 * assigned to themselves then still carry that name. It is the same person on
 * this machine, so close those as it rather than failing — #61 in reverse.
 * Every other assignee (a teammate, an agent) keeps bd's protection.
 */
export function closeActor(assignee: string | null | undefined): string {
  const { humanActor } = getConfig();
  return assignee && assignee !== humanActor && assignee === osUserName() ? assignee : humanActor;
}

/** Update global settings (actor / allowlist / poll / dashboard / chain / notes). Project registry has its own mutators. */
export function saveConfig(patch: SaveConfigPatch): AppConfig {
  const current = getConfig();
  let normalisedUrl: string | undefined;
  if (patch.workDashboardUrl !== undefined && patch.workDashboardUrl !== null) {
    const checked = checkWorkDashboardUrl(patch.workDashboardUrl);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedUrl = checked.url;
  }
  let normalisedSnapshot: string | undefined;
  if (patch.snapshotPath !== undefined && patch.snapshotPath !== null) {
    const checked = checkSnapshotPath(patch.snapshotPath);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedSnapshot = checked.value;
  }
  let normalisedHost: string | undefined;
  if (patch.serviceNowHost !== undefined && patch.serviceNowHost !== null) {
    const checked = checkServiceNowHost(patch.serviceNowHost);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedHost = checked.value;
  }
  let normalisedOrgs: string[] | undefined;
  if (patch.githubOrgs !== undefined && patch.githubOrgs !== null) {
    const checked = checkGithubOrgs(patch.githubOrgs);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedOrgs = checked.value;
  }
  let normalisedNotesUrl: string | undefined;
  if (patch.notesServiceUrl !== undefined && patch.notesServiceUrl !== null) {
    const checked = checkLoopbackServiceUrl(patch.notesServiceUrl);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedNotesUrl = checked.url;
  }
  let normalisedVault: string | undefined;
  if (patch.obsidianVault !== undefined && patch.obsidianVault !== null) {
    const checked = checkObsidianVault(patch.obsidianVault);
    if (!checked.ok) {
      throw new ConfigError(checked.reason, "invalid_config");
    }
    normalisedVault = checked.value;
  }
  const next: AppConfig = { ...current };
  if (patch.humanActor !== undefined) next.humanActor = patch.humanActor;
  if (patch.humanAllowlist !== undefined) next.humanAllowlist = patch.humanAllowlist;
  if (patch.pollIntervalMs !== undefined) next.pollIntervalMs = patch.pollIntervalMs;
  if (patch.gamification !== undefined) next.gamification = patch.gamification;
  if (patch.workDashboardUrl !== undefined) {
    if (patch.workDashboardUrl === null) {
      delete next.workDashboardUrl;
    } else {
      next.workDashboardUrl = normalisedUrl as string;
    }
  }
  if (patch.snapshotPath !== undefined) {
    if (patch.snapshotPath === null) {
      delete next.snapshotPath;
    } else {
      next.snapshotPath = normalisedSnapshot as string;
    }
  }
  if (patch.serviceNowHost !== undefined) {
    if (patch.serviceNowHost === null) {
      delete next.serviceNowHost;
    } else {
      next.serviceNowHost = normalisedHost as string;
    }
  }
  if (patch.githubOrgs !== undefined) {
    if (patch.githubOrgs === null) {
      delete next.githubOrgs;
    } else {
      next.githubOrgs = normalisedOrgs as string[];
    }
  }
  if (patch.notesServiceUrl !== undefined) {
    if (patch.notesServiceUrl === null) {
      delete next.notesServiceUrl;
    } else {
      next.notesServiceUrl = normalisedNotesUrl as string;
    }
  }
  if (patch.obsidianVault !== undefined) {
    if (patch.obsidianVault === null) {
      delete next.obsidianVault;
    } else {
      next.obsidianVault = normalisedVault as string;
    }
  }
  if (patch.humanActor !== undefined) next.humanActorChosen = true;
  const deleteKeys: string[] = [];
  if (patch.workDashboardUrl === null) deleteKeys.push("workDashboardUrl");
  if (patch.snapshotPath === null) deleteKeys.push("snapshotPath");
  if (patch.serviceNowHost === null) deleteKeys.push("serviceNowHost");
  if (patch.githubOrgs === null) deleteKeys.push("githubOrgs");
  if (patch.notesServiceUrl === null) deleteKeys.push("notesServiceUrl");
  if (patch.obsidianVault === null) deleteKeys.push("obsidianVault");
  if (deleteKeys.length > 0) {
    persist(next, deleteKeys);
  } else {
    persist(next);
  }
  return next;
}

// ---- project registry ----------------------------------------------------

export function listProjects(): ProjectEntry[] {
  return getConfig().projects;
}

export function getProject(id: string): ProjectEntry | DemoProject | undefined {
  if (id === DEMO_PROJECT.id) return DEMO_PROJECT;
  return getConfig().projects.find((p) => p.id === id);
}

/** Add (or re-touch) a project by folder path. Validates a `.beads` dir exists. */
export function addProject(inputPath: string): ProjectEntry {
  const cfg = getConfig();
  const abs = path.resolve(inputPath);
  if (!hasBeads(abs)) {
    throw new ConfigError(`No .beads directory found in ${abs}`, "no_beads");
  }
  const existing = cfg.projects.find((p) => sameDir(p.path, abs));
  if (existing) {
    existing.lastOpened = new Date().toISOString();
    persist(cfg);
    return existing;
  }
  const entry = makeEntry(abs, new Set(cfg.projects.map((p) => p.id)));
  cfg.projects.push(entry);
  persist(cfg);
  return entry;
}

export function removeProject(id: string): void {
  const cfg = getConfig();
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  // Drop any saved board ordering for the removed project so it can't orphan.
  if (cfg.orders[id]) {
    const rest = { ...cfg.orders };
    delete rest[id];
    cfg.orders = rest;
  }
  persist(cfg);
}

export function touchProject(id: string): void {
  const cfg = getConfig();
  const p = cfg.projects.find((x) => x.id === id);
  if (p) {
    p.lastOpened = new Date().toISOString();
    persist(cfg);
  }
}

export function renameProject(id: string, name: string): ProjectEntry | undefined {
  const cfg = getConfig();
  const p = cfg.projects.find((x) => x.id === id);
  if (!p) return undefined;
  p.name = name;
  persist(cfg);
  return p;
}

// ---- manual board ordering ------------------------------------------------

/** All saved column orders for a project: columnId → ordered bead ids. */
export function getColumnOrders(projectId: string): Record<string, string[]> {
  return getConfig().orders[projectId] ?? {};
}

/** Replace the saved order for one column of one project. */
export function setColumnOrder(
  projectId: string,
  columnId: string,
  ids: string[],
): Record<string, string[]> {
  const cfg = getConfig();
  const proj = { ...(cfg.orders[projectId] ?? {}) };
  proj[columnId] = ids;
  cfg.orders = { ...cfg.orders, [projectId]: proj };
  persist(cfg);
  return proj;
}
