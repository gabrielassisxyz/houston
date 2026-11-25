import "server-only";
import fs from "node:fs";
import { getConfig } from "./config";
import { parseSnapshot, type Snapshot } from "./snapshot-format";

export type SnapshotRead = { available: true; snapshot: Snapshot } | { available: false; reason: string };

/** Exact identity of the bytes read: the collector rewrites the file atomically, which changes the inode. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CacheEntry {
  path: string;
  identity: FileIdentity;
  result: SnapshotRead;
}

let cache: CacheEntry | null = null;

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

// The target is ES2017, so the bigints are compared with `===` and never against a `0n` literal.
function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function unavailable(reason: string): SnapshotRead {
  cache = null;
  return { available: false, reason };
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "the snapshot file does not exist";
  if (code === "EACCES" || code === "EPERM") return "the snapshot file is not readable";
  return `the snapshot file could not be read${code ? ` (${code})` : ""}`;
}

/**
 * Reads the snapshot file at the configured `snapshotPath`, parsing it again only when the file
 * is not the one last read. Synchronous, so two requests never race on the cache. Every answer
 * that is not a file read clears the cache, so a file that comes back is read again.
 */
export function readSnapshot(): SnapshotRead {
  const snapshotPath = getConfig().snapshotPath;
  if (snapshotPath === undefined) return unavailable("the snapshot path is not set");
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a named pipe at the path must not hold the server before the check below refuses it.
    fd = fs.openSync(snapshotPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return unavailable("the snapshot path is not a regular file");
    const identity = identityOf(stat);
    if (cache && cache.path === snapshotPath && sameIdentity(cache.identity, identity)) return cache.result;
    // The same descriptor, so the identity above describes exactly the bytes read here.
    const parsed = parseSnapshot(fs.readFileSync(fd, "utf8"));
    const result: SnapshotRead = parsed.ok
      ? { available: true, snapshot: parsed.snapshot }
      : { available: false, reason: parsed.reason };
    cache = { path: snapshotPath, identity, result };
    return result;
  } catch (error) {
    return unavailable(describeError(error));
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
