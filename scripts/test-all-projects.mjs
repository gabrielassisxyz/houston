// The all-projects endpoint. The first half is pure: lib/aggregate.ts and the time limit of
// lib/all-projects.ts load without a build. The second half needs SCOTTY_TEST_URL (an isolated
// server) and two or three throwaway br trackers; it skips when br is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const loaded = {};
function load(name, stubs = {}) {
  if (loaded[name]) return loaded[name];
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const req = (id) => (id === './aggregate' ? load('aggregate') : id in stubs ? stubs[id] : require(id));
  vm.runInNewContext(code, { exports, require: req, setTimeout, clearTimeout });
  return (loaded[name] = exports);
}

// Values built inside the vm context carry its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pure half
const agg = load('aggregate');
const dep = (to, type = 'blocks', from) => (from === undefined ? { depends_on_id: to, type } : { issue_id: from, depends_on_id: to, type });
const raw = (id, extra = {}) => ({ id, title: id, status: 'open', dependencies: [], ...extra });
const P = { id: 'alpha', name: 'Alpha' };

{
  const bead = raw('bd-1', { dependencies: [dep('bd-2', 'blocks', 'bd-1'), dep('bd-3', 'related')], parent: 'bd-9' });
  const out = agg.namespaceBead(P, bead);
  assert.equal(out.id, 'alpha:bd-1');
  assert.equal(out.local_id, 'bd-1');
  assert.deepEqual({ ...out.project }, P);
  assert.equal(out.parent, 'alpha:bd-9');
  assert.equal(out.dependencies[0].depends_on_id, 'alpha:bd-2');
  assert.equal(out.dependencies[0].issue_id, 'alpha:bd-1', 'issue_id is rewritten when present');
  assert.equal(out.dependencies[1].depends_on_id, 'alpha:bd-3');
  assert.ok(!('issue_id' in out.dependencies[1]), 'issue_id is not invented when absent');
  assert.equal(out.dependencies[1].type, 'related', 'other fields of a dependency survive');
  assert.equal(bead.id, 'bd-1', 'the input is not mutated');
  assert.equal(bead.dependencies[0].depends_on_id, 'bd-2', 'the input dependencies are not mutated');
  assert.ok(!('parent' in agg.namespaceBead(P, raw('bd-4'))), 'no parent is invented');
  assert.equal(agg.namespaceBead(P, raw('bd-4', { parent: null })).parent, null, 'a null parent stays null');
}
for (const original of ['bd-1', 'a:b', 'x.y.z', 'a:b.c:d', ':lead', 'trail:']) {
  const split = agg.splitId(agg.namespaceId('alpha', original));
  assert.deepEqual({ ...split }, { projectId: 'alpha', localId: original }, `round trip of ${original}`);
}
assert.equal(agg.splitId('no-namespace'), null);
assert.equal(agg.splitId(':x'), null);
{
  const plain = raw('bd-1');
  const merged = agg.namespaceBead(P, plain);
  assert.equal(agg.displayId(plain), 'bd-1');
  assert.equal(agg.displayId(merged), 'bd-1', 'displayId shows the tracker id');
  assert.equal(agg.projectOf(plain), undefined);
  assert.deepEqual({ ...agg.projectOf(merged) }, P);
}

// The time limit, with the reader injected so a stub can stall.
{
  const stall = new Promise(() => {});
  const reader = async (p) => {
    if (p.id === 'slow') return stall;
    if (p.id === 'broken') throw new Error('boom');
    if (p.id === 'blank') throw new Error('');
    return { kind: 'br', beads: [raw('bd-1'), raw('bd-2')] };
  };
  const projects = ['fast', 'slow', 'broken', 'blank'].map((id) => ({ id, name: id.toUpperCase() }));
  const { readAllProjects, TIMED_OUT, PROJECT_READ_LIMIT_MS } = load('all-projects', { 'server-only': {}, './store': {}, './beads-watch': {} });
  assert.equal(PROJECT_READ_LIMIT_MS, 15000, 'the default limit is 15 seconds');
  assert.equal(TIMED_OUT, 'timed out');
  const t0 = Date.now();
  const res = await readAllProjects(projects, reader, 150);
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 2000, `waited about the limit, not longer: ${took}ms`);
  assert.deepEqual(plain(res.failed.map((f) => [f.id, f.name, f.error])), [['slow', 'SLOW', 'timed out'], ['broken', 'BROKEN', 'boom'], ['blank', 'BLANK', 'unreadable']]);
  assert.deepEqual(plain(res.projects), [{ id: 'fast', name: 'FAST', kind: 'br', count: 2 }]);
  assert.deepEqual(plain(res.beads.map((b) => b.id)), ['fast:bd-1', 'fast:bd-2'], 'the other projects are still returned');
}
console.log('PASS (unit): namespacing, id round trip, displayId/projectOf, per-project time limit');

// ---------------------------------------------------------------- server half
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
const BR = process.env.BR_BIN || 'br';
try { execFileSync(BR, ['--version'], { stdio: 'ignore' }); } catch {
  console.log('SKIP server half: br is not installed');
  process.exit(0);
}

const json = { 'Content-Type': 'application/json' };
const dirs = [];
const registered = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const brIn = (cwd, args) => execFileSync(BR, args, { cwd, encoding: 'utf8' });
const register = async (dir) => {
  const res = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(res.status, 201, `register ${dir}: ${await res.clone().text()}`);
  const id = (await res.json()).id;
  registered.push(id);
  return id;
};
const getAll = async () => {
  const res = await fetch(`${base}/api/all/beads`);
  assert.equal(res.status, 200, `all: ${await res.clone().text()}`);
  return res.json();
};

// A server started from a checkout registers that checkout too; the test only judges its own.
const failedOf = (answer, ids) => answer.meta.failed.filter((f) => ids.includes(f.id));

// The number of inotify watches the server holds: one per fs.watch on a directory. Read from
// /proc so the test needs no hook inside the server.
function serverPid() {
  const port = new URL(base).port;
  const m = /pid=(\d+)/.exec(execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }));
  assert.ok(m, `no process listens on port ${port}`);
  return Number(m[1]);
}
function inotifyWatches(pid) {
  let n = 0;
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      n += (fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^inotify wd:/gm) ?? []).length;
    } catch { /* the fd closed meanwhile */ }
  }
  return n;
}

try {
  // Tracker A: 3 beads with a blocks edge and a parent edge. B is a byte copy, so ids collide.
  const a = tmp('scotty-all-a-');
  execFileSync('git', ['init', '-q'], { cwd: a });
  brIn(a, ['init', '--prefix', 'bd']);
  const create = (title, extra = []) => JSON.parse(brIn(a, ['create', title, '--json', ...extra])).id;
  const epic = create('the epic', ['-t', 'epic']);
  const blocker = create('the blocker');
  const work = create('the work');
  brIn(a, ['dep', 'add', work, blocker, '-t', 'blocks']);
  brIn(a, ['dep', 'add', work, epic, '-t', 'parent-child']);
  const b = path.join(tmp('scotty-all-b-'), 'copy');
  fs.cpSync(a, b, { recursive: true });
  const aId = await register(a);
  const bId = await register(b);
  assert.notEqual(aId, bId);

  const before = await getAll();
  const mine = before.beads.filter((x) => [aId, bId].includes(x.project.id));

  // 6 beads, 6 distinct ids, 3 per project, local_id is the tracker's id.
  assert.equal(mine.length, 6, `6 beads: ${mine.map((x) => x.id)}`);
  assert.equal(new Set(mine.map((x) => x.id)).size, 6, 'ids are distinct');
  assert.equal(new Set(before.beads.map((x) => x.id)).size, before.beads.length, 'ids are distinct across the whole answer');
  for (const pid of [aId, bId]) assert.equal(mine.filter((x) => x.project.id === pid).length, 3);
  const trackerIds = new Set([epic, blocker, work]);
  for (const x of mine) {
    assert.ok(trackerIds.has(x.local_id), `local_id ${x.local_id} is an id the tracker reports`);
    assert.equal(x.id, `${x.project.id}:${x.local_id}`);
  }
  assert.ok(mine.every((x) => typeof x.project.name === 'string' && x.project.name.length > 0));

  // Every dependency and parent resolves inside the answer, in the same project.
  const byId = new Map(before.beads.map((x) => [x.id, x]));
  let edges = 0;
  for (const x of mine) {
    for (const d of x.dependencies) {
      edges += 1;
      const target = byId.get(d.depends_on_id);
      assert.ok(target, `${x.id} -> ${d.depends_on_id} is in the response`);
      assert.equal(target.project.id, x.project.id, 'a dependency never crosses projects');
    }
    if (x.parent) assert.equal(byId.get(x.parent)?.project.id, x.project.id, `parent of ${x.id}`);
  }
  assert.equal(edges, 4, 'the edges were seen: 2 per project');

  // meta lists every project read, with its count, and reports the viewer mode.
  const viewerModeRes = await fetch(`${base}/api/viewer-mode`);
  assert.equal(viewerModeRes.status, 200, `viewer-mode: ${await viewerModeRes.clone().text()}`);
  const viewerMode = await viewerModeRes.json();
  assert.equal(before.meta.kind, 'all');
  assert.equal(before.meta.readOnly, viewerMode.readOnly);
  assert.equal(typeof before.meta.humanActor, 'string');
  assert.ok(Array.isArray(before.meta.humanAllowlist));
  assert.equal(typeof before.meta.pollIntervalMs, 'number');
  for (const pid of [aId, bId]) {
    const entry = before.meta.projects.find((p) => p.id === pid);
    assert.ok(entry, `meta.projects lists ${pid}`);
    assert.equal(entry.count, 3);
    assert.equal(entry.kind, 'br');
  }
  assert.deepEqual(failedOf(before, [aId, bId]), [], 'neither of the two projects failed');

  // A third project whose tracker file is gone is named, and the others survive.
  const c = tmp('scotty-all-c-');
  execFileSync('git', ['init', '-q'], { cwd: c });
  brIn(c, ['init', '--prefix', 'bd']);
  brIn(c, ['create', 'doomed project bead', '--json']);
  const cId = await register(c);
  assert.equal(failedOf(await getAll(), [aId, bId, cId]).length, 0, 'the third project reads while its file exists');
  fs.rmSync(path.join(c, '.beads', 'issues.jsonl'));
  const after = await getAll();
  const failed = failedOf(after, [aId, bId, cId]);
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.equal(failed[0].id, cId);
  assert.ok(failed[0].name.length > 0);
  assert.ok(failed[0].error.length > 0, 'the failure says why');
  assert.equal(after.beads.filter((x) => [aId, bId].includes(x.project.id)).length, 6, 'the others are returned');
  assert.ok(!after.meta.projects.some((p) => p.id === cId), 'a failed project is not listed as read');
  // c stays registered but broken for the rest; the stream still has to cope with it.

  // Taken before any stream opens, so a stream that leaks anywhere below changes the count.
  const pid = serverPid();
  const baseline = inotifyWatches(pid);

  // Stream: loud on a write in either project, silent across reads.
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/all/beads/stream`, { signal: abort.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let changes = 0;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        changes += decoder.decode(value).split('event: change').length - 1;
      }
    } catch { /* aborted */ }
  })();
  await sleep(1000);
  changes = 0;
  for (let i = 0; i < 10; i++) {
    await getAll();
    await sleep(300);
  }
  assert.equal(changes, 0, 'ten reads emit no change event');
  for (const dir of [a, b]) {
    changes = 0;
    brIn(dir, ['update', blocker, '--title', `renamed in ${path.basename(dir)}`]);
    const deadline = Date.now() + 5000;
    while (changes === 0 && Date.now() < deadline) await sleep(100);
    assert.ok(changes > 0, `a br update in ${path.basename(dir)} emits a change event within 5s`);
    await sleep(500);
  }
  abort.abort();
  await pump;

  // Closing the stream releases its watchers.
  await sleep(500);
  assert.equal(inotifyWatches(pid), baseline, 'the first stream released its watchers when it closed');
  const probe = new AbortController();
  const open = await fetch(`${base}/api/all/beads/stream`, { signal: probe.signal });
  const probeReader = open.body.getReader();
  await probeReader.read(); // the ': connected' comment: the subscriptions are made before it
  await sleep(300);
  assert.ok(inotifyWatches(pid) >= baseline + 3, `an open stream holds a watch per project: ${baseline} -> ${inotifyWatches(pid)}`);
  probe.abort();
  for (let i = 0; i < 20; i++) {
    const c2 = new AbortController();
    const res = await fetch(`${base}/api/all/beads/stream`, { signal: c2.signal });
    await res.body.getReader().read();
    c2.abort();
  }
  await sleep(1000);
  assert.equal(inotifyWatches(pid), baseline, 'after 20 open-and-close cycles the watcher count is what it was');
  console.log('PASS (server): distinct ids, dependency closure, failed project reported, meta, stream signal and cleanup');
} finally {
  for (const id of registered) await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
