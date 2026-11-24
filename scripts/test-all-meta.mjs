// Isolated server only. Proves that GET /api/all/beads reports the effective viewer mode in
// meta.readOnly, agrees with GET /api/viewer-mode under both cookies and with no cookie, and
// matches the write guard on a throwaway br tracker. Skips when br is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated app server');
const BR = process.env.BR_BIN || 'br';
try {
  execFileSync(BR, ['--version'], { stdio: 'ignore' });
} catch {
  console.log('SKIP all meta: br is not installed');
  process.exit(0);
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const EDITING_COOKIE = 'scotty-viewer-mode=editing';
const READ_ONLY_COOKIE = 'scotty-viewer-mode=read-only';

async function getJson(pathname, cookie) {
  const headers = cookie ? { Cookie: cookie } : undefined;
  const res = await fetch(`${base}${pathname}`, { headers });
  const text = await res.text();
  assert.equal(res.status, 200, `${pathname} (${cookie ?? 'no cookie'}): ${res.status} ${text}`);
  return JSON.parse(text);
}

// 1. Cookie overrides and launch default: meta.readOnly and /api/viewer-mode agree.
{
  const [allEditing, modeEditing] = await Promise.all([
    getJson('/api/all/beads', EDITING_COOKIE),
    getJson('/api/viewer-mode', EDITING_COOKIE),
  ]);
  assert.equal(modeEditing.readOnly, false, 'viewer-mode reports false under editing cookie');
  assert.equal(allEditing.meta.readOnly, false, 'merged list meta.readOnly is false under editing cookie');

  const [allReadOnly, modeReadOnly] = await Promise.all([
    getJson('/api/all/beads', READ_ONLY_COOKIE),
    getJson('/api/viewer-mode', READ_ONLY_COOKIE),
  ]);
  assert.equal(modeReadOnly.readOnly, true, 'viewer-mode reports true under read-only cookie');
  assert.equal(allReadOnly.meta.readOnly, true, 'merged list meta.readOnly is true under read-only cookie');

  const [allDefault, modeDefault] = await Promise.all([
    getJson('/api/all/beads'),
    getJson('/api/viewer-mode'),
  ]);
  assert.equal(typeof modeDefault.readOnly, 'boolean', 'viewer-mode returns a boolean with no cookie');
  assert.equal(
    allDefault.meta.readOnly,
    modeDefault.readOnly,
    'merged list meta.readOnly matches viewer-mode with no cookie',
  );
}

// 2. Write guard agreement on a throwaway br tracker: 403 read_only vs 200 persisted update.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-all-meta-'));
let projectId;
try {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync(BR, ['init', '--prefix', 'am'], { cwd: dir, encoding: 'utf8' });

  const addRes = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: dir }),
  });
  assert.equal(addRes.status, 201, `register tracker: ${addRes.status} ${await addRes.clone().text()}`);
  projectId = (await addRes.json()).id;
  const api = `${base}/api/p/${projectId}`;

  // Create a bead via the API using the editing cookie so setup works under both launches.
  const createRes = await fetch(`${api}/beads`, {
    method: 'POST',
    headers: { ...jsonHeaders, Cookie: EDITING_COOKIE },
    body: JSON.stringify({ title: 'viewer mode status check' }),
  });
  const createText = await createRes.text();
  assert.equal(createRes.status, 201, `create bead: ${createRes.status} ${createText}`);
  const created = JSON.parse(createText);
  assert.equal(created.status, 'open', 'new bead starts open');

  // Under the read-only cookie, a status write is refused with 403 / read_only and changes nothing.
  const blockedRes = await fetch(`${api}/beads/${created.id}/status`, {
    method: 'POST',
    headers: { ...jsonHeaders, Cookie: READ_ONLY_COOKIE },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  const blockedText = await blockedRes.text();
  assert.equal(blockedRes.status, 403, `read-only status write: ${blockedRes.status} ${blockedText}`);
  assert.equal(JSON.parse(blockedText).code, 'read_only', 'refusal code is read_only');
  const afterBlocked = await getJson(`/api/p/${projectId}/beads/${created.id}`);
  assert.equal(afterBlocked.status, 'open', 'refused status write left the bead open');

  // Under the editing cookie, the same status write succeeds with 200 and persists.
  const allowedRes = await fetch(`${api}/beads/${created.id}/status`, {
    method: 'POST',
    headers: { ...jsonHeaders, Cookie: EDITING_COOKIE },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  const allowedText = await allowedRes.text();
  assert.equal(allowedRes.status, 200, `editing status write: ${allowedRes.status} ${allowedText}`);
  const afterAllowed = await getJson(`/api/p/${projectId}/beads/${created.id}`);
  assert.equal(afterAllowed.status, 'in_progress', 'status write persisted when read back through the API');
} finally {
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('PASS all meta: meta.readOnly agrees with viewer-mode and the write guard under cookies and default');
