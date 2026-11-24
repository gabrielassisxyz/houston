// Status history for br projects.
// Unit half: always runs, no build and no tracker (stub runner).
// End-to-end half: runs only when SCOTTY_TEST_URL points at an isolated server, uses a throwaway
// br tracker under os.tmpdir(), and skips when br is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);
const logged = [];
function load(name, stubs = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const req = (id) => (id in stubs ? stubs[id] : nodeRequire(id));
  const console = { error: (...a) => logged.push(a.join(' ')), log() {} };
  vm.runInNewContext(code, { exports, require: req, console, process, setTimeout });
  return exports;
}

// Values built inside the vm carry that realm's prototypes; compare their JSON instead.
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audit = (issueId, events) => JSON.stringify({ issue_id: issueId, events });
const beadsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, updated_at: `2026-11-21T10:00:0${i % 10}Z` }));

// --- unit: event mapping -------------------------------------------------------------------
{
  const { mapAuditLog } = load('br-events', { './interactions': {} });
  const out = mapAuditLog('t-1', audit('t-1', [
    { id: 1, event_type: 'created', actor: 'a', timestamp: '2026-11-21T10:00:00.000000001Z' },
    { id: 2, event_type: 'status_changed', actor: 'alice', timestamp: '2026-11-21T20:09:37.138012029Z', old_value: 'open', new_value: 'in_progress' },
    { id: 3, event_type: 'priority_changed', actor: 'bob', timestamp: '2026-11-21T20:10:00.5Z', old_value: '2', new_value: '0' },
    { id: 4, event_type: 'closed', actor: 'a', timestamp: '2026-11-21T20:11:00Z' },
    { id: 5, event_type: 'reopened', actor: 'a', timestamp: '2026-11-21T20:12:00Z' },
    { id: 6, event_type: 'commented', actor: 'a', timestamp: '2026-11-21T20:13:00Z' },
    { id: 7, event_type: 'label_added', actor: 'a', timestamp: '2026-11-21T20:14:00Z' },
  ]));
  assert.equal(out.length, 2, 'only status_changed and priority_changed become entries');
  assert.deepEqual(plain(out[0]), {
    kind: 'field_change', issue_id: 't-1', created_at: '2026-11-21T20:09:37.138Z', actor: 'alice',
    extra: { field: 'status', old_value: 'open', new_value: 'in_progress' },
  });
  assert.deepEqual(plain(out[1].extra), { field: 'priority', old_value: '2', new_value: '0' });
  assert.ok(Number.isFinite(Date.parse(out[0].created_at)), 'created_at parses');
  console.log('PASS unit: mapping keeps status and priority changes only, in the consumer shape');
}

// --- unit: cache count and invalidation ----------------------------------------------------
{
  const { readBrEvents } = load('br-events', { './interactions': {} });
  const beads = beadsOf(5);
  let calls = 0;
  const run = async (cmd, args) => {
    calls++;
    const id = args[2];
    return { stdout: audit(id, [{ id: 1, event_type: 'status_changed', actor: 'x', timestamp: '2026-11-21T10:00:00Z', old_value: 'open', new_value: 'closed' }]) };
  };
  const first = await readBrEvents('/repo/a', beads, run);
  const second = await readBrEvents('/repo/a', beads, run);
  assert.equal(calls, 5, 'two reads over the same 5 beads run the runner 5 times');
  assert.equal(first.length, 5);
  assert.deepEqual(plain(second), plain(first));
  const changed = beads.map((b, i) => (i === 2 ? { ...b, updated_at: '2026-11-21T11:00:00Z' } : b));
  await readBrEvents('/repo/a', changed, run);
  assert.equal(calls, 6, 'one bead with a new updated_at costs exactly one more call');
  await readBrEvents('/repo/b', beads, run);
  assert.equal(calls, 11, 'the cache is per repository');
  console.log('PASS unit: cache holds per bead and updated_at, invalidates one bead, is per repository');
}

// --- unit: concurrency bound ---------------------------------------------------------------
{
  const { readBrEvents } = load('br-events', { './interactions': {} });
  let inFlight = 0, peak = 0;
  const run = async (cmd, args) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight--;
    return { stdout: audit(args[2], []) };
  };
  await readBrEvents('/repo/c', beadsOf(40), run);
  assert.ok(peak <= 8, `never more than 8 in flight, saw ${peak}`);
  assert.equal(peak, 8, 'the bound is actually used');
  console.log('PASS unit: 40 beads never run more than 8 processes at once');
}

// --- unit: callers arriving together -------------------------------------------------------
// The activity, insights and gamification routes ask for one project's history at the same
// moment. They must share the fetches and the bound, not multiply them.
{
  const { readBrEvents } = load('br-events', { './interactions': {} });
  let calls = 0, inFlight = 0, peak = 0;
  const run = async (cmd, args) => {
    calls++; inFlight++; peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight--;
    return { stdout: audit(args[2], [{ id: 1, event_type: 'status_changed', actor: 'x', timestamp: '2026-11-21T10:00:00Z', new_value: 'closed' }]) };
  };
  const beads = beadsOf(40);
  const [a, b, c] = await Promise.all([
    readBrEvents('/repo/d', beads, run),
    readBrEvents('/repo/d', beads, run),
    readBrEvents('/repo/d', beads, run),
  ]);
  assert.equal(calls, 40, `three callers at once fetch each bead once, saw ${calls} calls`);
  assert.ok(peak <= 8, `three callers at once stay within 8 in flight, saw ${peak}`);
  assert.equal(a.length, 40);
  assert.deepEqual(plain(b), plain(a));
  assert.deepEqual(plain(c), plain(a));
  // Different repositories share nothing but the bound.
  peak = 0;
  await Promise.all([readBrEvents('/repo/e', beads, run), readBrEvents('/repo/f', beads, run)]);
  assert.equal(calls, 120, 'two repositories are fetched independently');
  assert.ok(peak <= 8, `two repositories at once stay within 8 in flight, saw ${peak}`);
  console.log('PASS unit: concurrent callers share fetches and one process-wide bound');
}

// --- unit: one failing bead ----------------------------------------------------------------
{
  const { readBrEvents } = load('br-events', { './interactions': {} });
  logged.length = 0;
  const run = async (cmd, args) => {
    if (args[2] === 't-1') throw new Error('boom');
    return { stdout: audit(args[2], [{ id: 1, event_type: 'status_changed', actor: 'x', timestamp: '2026-11-21T10:00:00Z', new_value: 'closed' }]) };
  };
  const out = await readBrEvents('/repo/d', beadsOf(3), run);
  assert.deepEqual(plain(out.map((e) => e.issue_id)), ['t-0', 't-2'], 'other beads keep their events');
  assert.equal(logged.length, 1, 'exactly one log line');
  assert.ok(logged[0].includes('t-1'), `the line names the bead: ${logged[0]}`);
  console.log('PASS unit: one failing bead yields no events for it, one log line, others intact');
}

// --- unit: dispatch in lib/events.ts -------------------------------------------------------
{
  const calls = [];
  const stubs = (kind, path = '/p') => ({
    'server-only': {},
    './config': { getProject: () => (path === null ? { path: null } : { path }) },
    './store': { getStore: async () => ({ kind }) },
    './interactions': { readInteractions: (p) => { calls.push(['bd', p]); return [{ id: 'bd-event' }]; } },
    './br-events': { readBrEvents: async (p, b) => { calls.push(['br', p, b.length]); return [{ id: 'br-event' }]; } },
  });
  const beads = [{ id: 'x' }];
  assert.deepEqual(plain(await load('events', stubs('bd')).projectEvents('p', beads)), [{ id: 'bd-event' }]);
  assert.deepEqual(plain(await load('events', stubs('br')).projectEvents('p', beads)), [{ id: 'br-event' }]);
  assert.deepEqual(plain(await load('events', stubs('demo', null)).projectEvents('demo', beads)), []);
  assert.deepEqual(calls, [['bd', '/p'], ['br', '/p', 1]]);
  console.log('PASS unit: bd reads interactions.jsonl, br reads the audit log, demo is empty');
}

// --- unit: readInteractions has one caller -------------------------------------------------
{
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'scripts'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && /readInteractions\(/.test(readFileSync(p, 'utf8'))) hits.push(path.relative(process.cwd(), p));
    }
  };
  for (const d of ['lib', 'app', 'components', 'hooks']) if (fs.existsSync(d)) walk(d);
  assert.deepEqual(hits.sort(), ['lib/events.ts', 'lib/interactions.ts'], `readInteractions( appears in: ${hits}`);
  console.log('PASS unit: readInteractions is defined in lib/interactions.ts and called only from lib/events.ts');
}

// --- end to end ----------------------------------------------------------------------------
const base = process.env.SCOTTY_TEST_URL;
const BR = process.env.BR_BIN || 'br';
if (!base) {
  console.log('SKIP e2e br history: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
try { execFileSync(BR, ['--version'], { stdio: 'ignore' }); } catch {
  console.log('SKIP e2e br history: br is not installed');
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-brev-'));
const json = { 'Content-Type': 'application/json' };
let projectId;
try {
  // cwd is always the throwaway directory: br resolves its tracker from there.
  const br = (args) => execFileSync(BR, args, { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  br(['init', '--prefix', 'bt']);
  const id = JSON.parse(br(['create', 'history bead', '--json'])).id;
  br(['--actor', 'alice', 'update', id, '-s', 'in_progress']);
  br(['--actor', 'alice', 'close', id]);

  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(added.status, 201);
  projectId = (await added.json()).id;
  const api = `${base}/api/p/${projectId}`;

  const act = await fetch(`${api}/activity`);
  assert.equal(act.status, 200, await act.clone().text());
  const items = (await act.json()).items.filter((i) => i.issueId === id);
  const started = items.find((i) => i.action.startsWith('claimed'));
  const closed = items.find((i) => i.action === 'closed');
  assert.ok(started, `a started item: ${JSON.stringify(items)}`);
  assert.ok(closed, `a closed item: ${JSON.stringify(items)}`);
  assert.equal(started.actor, 'alice');
  assert.equal(closed.actor, 'alice');

  const ins = await fetch(`${api}/insights`);
  assert.equal(ins.status, 200, await ins.clone().text());
  assert.equal((await ins.json()).hasEvents, true);
  console.log('PASS e2e br history: activity shows started and closed by alice, insights has events');
} finally {
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
  fs.rmSync(dir, { recursive: true, force: true });
}
