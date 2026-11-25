// Pure tests for scripts/notes-backup.sh.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupScript = path.join(root, "scripts", "notes-backup.sh");

// Syntax check.
execFileSync("bash", ["-n", backupScript], { stdio: "pipe" });

// sqlite3 must be on PATH for these tests.
const which = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf8" });
assert.ok((which.stdout || "").trim(), "sqlite3 must be on PATH for test-notes-backup");

const today = execFileSync("date", ["+%F"], { encoding: "utf8" }).trim();
assert.match(today, /^\d{4}-\d{2}-\d{2}$/, "date +%F gives an ISO day");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "houston-backup-"));
try {
  // A live database in WAL mode holding one row.
  const dbPath = path.join(scratch, "notes.db");
  execFileSync("sqlite3", [dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE t(x TEXT); INSERT INTO t VALUES('hello');"], { stdio: "pipe" });

  // A backup folder whose name holds a space and an apostrophe, seeded with
  // nine older copies and one unrelated file.
  const syncDir = path.join(scratch, "my backup's dir");
  fs.mkdirSync(syncDir, { recursive: true });
  const backupDir = path.join(syncDir, "houston-backup");
  fs.mkdirSync(backupDir, { recursive: true });
  for (let day = 1; day <= 9; day++) {
    const name = `notes-2020-01-0${day}.db`;
    fs.writeFileSync(path.join(backupDir, name), `seed ${name}\n`);
  }
  const unrelated = path.join(backupDir, "keep.txt");
  fs.writeFileSync(unrelated, "do not touch\n");

  // A stale partial from a failed run is removed by the next run.
  const stalePartial = path.join(backupDir, `.notes-${today}.db.partial`);
  fs.writeFileSync(stalePartial, "stale\n");

  // First run.
  execFileSync("bash", [backupScript, dbPath, syncDir], { stdio: "pipe" });

  const finalName = `notes-${today}.db`;
  const finalPath = path.join(backupDir, finalName);
  assert.equal(fs.existsSync(finalPath), true, "today's copy exists");

  // The copy passes integrity_check and holds the row.
  const integrity = execFileSync("sqlite3", [finalPath, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  assert.equal(integrity, "ok", "backup passes PRAGMA integrity_check");
  const row = execFileSync("sqlite3", [finalPath, "SELECT x FROM t;"], { encoding: "utf8" }).trim();
  assert.equal(row, "hello", "backup holds the row");

  // Exactly seven notes-*.db remain: today's and the six newest seeded.
  const copies = fs.readdirSync(backupDir).filter((f) => f.startsWith("notes-") && f.endsWith(".db")).sort();
  const expected = [
    "notes-2020-01-04.db",
    "notes-2020-01-05.db",
    "notes-2020-01-06.db",
    "notes-2020-01-07.db",
    "notes-2020-01-08.db",
    "notes-2020-01-09.db",
    finalName,
  ].sort();
  assert.deepEqual(copies, expected, "seven copies remain: today plus the six newest seeded");

  // The unrelated file survives and no .partial is left.
  assert.equal(fs.readFileSync(unrelated, "utf8"), "do not touch\n", "unrelated file survives");
  const partials = fs.readdirSync(backupDir).filter((f) => f.endsWith(".partial"));
  assert.deepEqual(partials, [], "no .partial is left");

  // A second run on the same day succeeds and still leaves seven.
  execFileSync("bash", [backupScript, dbPath, syncDir], { stdio: "pipe" });
  const copies2 = fs.readdirSync(backupDir).filter((f) => f.startsWith("notes-") && f.endsWith(".db")).sort();
  assert.deepEqual(copies2, expected, "second run on the same day still leaves seven");
  const integrity2 = execFileSync("sqlite3", [finalPath, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  assert.equal(integrity2, "ok", "second run leaves a good copy");
  const partials2 = fs.readdirSync(backupDir).filter((f) => f.endsWith(".partial"));
  assert.deepEqual(partials2, [], "no .partial after the second run");

  // A missing database exits non-zero and deletes nothing.
  const before = fs.readdirSync(backupDir).slice().sort();
  const missing = spawnSync("bash", [backupScript, path.join(scratch, "no-such.db"), syncDir], { encoding: "utf8" });
  assert.notEqual(missing.status, 0, "missing database exits non-zero");
  assert.match(missing.stderr, /not found|missing|no such/i, "missing database names the problem");
  const after = fs.readdirSync(backupDir).slice().sort();
  assert.deepEqual(after, before, "missing database deletes nothing");

  console.log("PASS notes-backup: VACUUM INTO copy, retention, second run, and missing db");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
