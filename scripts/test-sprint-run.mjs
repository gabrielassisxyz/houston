// Starting and closing a sprint on the server. The first half is pure: lib/sprint-run.ts loads
// without a build and runs against a fake reader, a fake label writer, a real sprint store on a
// temporary file and a fixed clock. The second half needs SCOTTY_TEST_URL (an isolated server)
// and two throwaway br trackers; it skips when br is not installed.
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const req = (id) => {
    if (id === './sprints') return load('sprints');
    if (id === './sprint-model') return load('sprint-model');
    return id in stubs ? stubs[id] : require(id);
  };
  vm.runInNewContext(code, { exports, require: req, process, structuredClone, Date, console });
  return (loaded[name] = exports);
}
load('sprints', { 'server-only': {} });
load('sprint-model');
const run = load('sprint-run', {
  'server-only': {}, './config': {}, './all-projects': {}, './store': {},
});
const { createSprintStore } = load('sprints');

// Values built inside the vm context carry its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const dirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const refused = async (promise, status, code) => {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    assert.equal(e.status, status);
    return e;
  }
  assert.fail(`expected ${code}`);
};

const SID = '2026-12-01';
const LABEL = `sprint:${SID}`;
const P1 = { id: 'p1', name: 'One' };
const P2 = { id: 'p2', name: 'Two' };
const bead = (project, id, extra = {}) => ({
  project, local_id: id, id: `${project.id}:${id}`, title: `title ${id}`, status: 'open', labels: [LABEL], ...extra,
});

// A world of beads, a reader over it, a label writer that records its calls and can be told to
// fail, a record store on a temporary file and a clock that never moves.
async function env(beads, { failed = [], sprint = {} } = {}) {
  const world = { beads, failed, writes: [], writeFails: new Map(), notFound: new Set(), reads: 0 };
  const store = createSprintStore(path.join(tmp('scotty-run-'), 'sprints.json'));
  await store.create({ name: 'Sprint', start: SID, end: '2026-12-14', capacity: 10 });
  if (Object.keys(sprint).length) await store.mutate(SID, (s) => ({ ...s, ...sprint }));
  const key = (p, id) => `${p}/${id}`;
  const deps = {
    readAll: async () => { world.reads += 1; return { beads: world.beads, failed: world.failed }; },
    removeLabel: async (projectId, beadId, label) => {
      world.writes.push([projectId, beadId, label]);
      if (world.notFound.has(key(projectId, beadId))) throw Object.assign(new Error('no such bead'), { code: 'not_found' });
      if (world.writeFails.has(key(projectId, beadId))) throw new Error(world.writeFails.get(key(projectId, beadId)));
      const target = world.beads.find((b) => b.project.id === projectId && b.local_id === beadId);
      if (target) target.labels = target.labels.filter((l) => l !== label);
    },
    store,
    now: () => new Date('2026-12-02T10:00:00.000Z'),
  };
  return { world, store, deps, key };
}
const labelsOf = (world, p, id) => world.beads.find((b) => b.project.id === p.id && b.local_id === id).labels;
const ids = (refs) => Array.from(refs, (r) => `${r.projectId}/${r.id}`);

// ---------------------------------------------------------------- pure half
// Start: the planned set, with project, own id, title, size and points as they are now.
{
  const { world, store, deps } = await env([
    bead(P1, 'a', { labels: [LABEL, 'size:M'] }),
    bead(P1, 'b', { labels: [LABEL, 'size:XL'] }),
    bead(P2, 'a', { title: 'same id elsewhere', labels: [LABEL] }),
    bead(P2, 'z', { labels: ['sprint:2026-12-15'] }),
  ], { failed: [{ id: 'p3', name: 'Three', error: 'boom' }] });
  const started = await run.startSprint(SID, deps);
  assert.equal(started.state, 'active');
  assert.equal(started.startedAt, '2026-12-02T10:00:00.000Z');
  assert.deepEqual(plain(started.planned), [
    { projectId: 'p1', projectName: 'One', id: 'a', title: 'title a', size: 'M', points: 2 },
    { projectId: 'p1', projectName: 'One', id: 'b', title: 'title b', size: 'XL', points: 5 },
    { projectId: 'p2', projectName: 'Two', id: 'a', title: 'same id elsewhere', size: null, points: 0 },
  ], 'the planned set holds the bead\'s own id (not the namespaced one) and its size and points');
  assert.deepEqual(plain(started.unreadableAtStart), ['Three'], 'a project that failed to read is recorded, and does not stop the start');
  assert.deepEqual(plain(await store.get(SID)), plain(started), 'the record on disk is the answer');
  assert.deepEqual(world.writes, [], 'starting writes no label');
  await refused(run.startSprint(SID, deps), 409, 'sprint_not_planned');
}
// Start refusals.
{
  const { deps, store } = await env([bead(P1, 'a')]);
  await refused(run.startSprint('2030-01-01', deps), 404, 'unknown_sprint');
  await store.create({ name: 'Other', start: '2026-11-01', end: '2026-11-14', capacity: 1 });
  for (const state of ['active', 'closing']) {
    await store.mutate('2026-11-01', (s) => ({ ...s, state }));
    const err = await refused(run.startSprint(SID, deps), 409, 'another_sprint_running');
    assert.ok(err.message.includes('2026-11-01'), 'the message names the running sprint');
    assert.equal((await store.get(SID)).state, 'planned', 'nothing was started');
  }
  await store.mutate('2026-11-01', (s) => ({ ...s, state: 'closed' }));
  assert.equal((await run.startSprint(SID, deps)).state, 'active', 'a closed sprint does not hold up the next one');
}
{
  const { deps, store } = await env([bead(P1, 'a', { labels: ['sprint:2026-12-15'] })]);
  await refused(run.startSprint(SID, deps), 409, 'sprint_empty');
  assert.equal((await store.get(SID)).state, 'planned', 'an empty sprint stays planned');
}
// Close: the case of the bead. A closed, B open, C lost its label, D closed, E added and open.
function activeSprint(world) {
  const planned = (p, id, size, points) => ({ projectId: p.id, projectName: p.name, id, title: `title ${id}`, size, points });
  return {
    state: 'active', startedAt: '2026-12-01T08:00:00.000Z',
    planned: [planned(P1, 'A', 'S', 1), planned(P1, 'B', 'M', 2), planned(P2, 'C', 'L', 3), planned(P2, 'D', 'XL', 5)],
    unreadableAtStart: world,
  };
}
const caseBeads = () => [
  bead(P1, 'A', { status: 'closed', labels: [LABEL, 'size:S'] }),
  // B is being worked on and E is blocked: neither is done. Only `closed` counts as done.
  bead(P1, 'B', { status: 'in_progress', labels: [LABEL, 'size:M'] }),
  bead(P2, 'C', { labels: ['size:L'] }),
  bead(P2, 'D', { status: 'closed', labels: [LABEL, 'size:XL'] }),
  bead(P2, 'E', { status: 'blocked', labels: [LABEL, 'size:S'] }),
];
{
  const { world, store, deps } = await env(caseBeads(), { sprint: activeSprint([]) });
  const { sprint, remaining } = await run.closeSprint(SID, deps);
  assert.deepEqual(plain(remaining), []);
  assert.equal(sprint.state, 'closed');
  assert.equal(sprint.closedAt, '2026-12-02T10:00:00.000Z');
  assert.deepEqual(plain(sprint.pending), []);
  const s = sprint.summary;
  assert.equal(s.plannedCount, 4);
  assert.equal(s.plannedPoints, 11, 'the planned points are the sum of the four planned beads');
  assert.deepEqual(ids(s.done), ['p1/A', 'p2/D']);
  assert.deepEqual(ids(s.spillover), ['p1/B', 'p2/E']);
  assert.deepEqual(ids(s.added), ['p2/E']);
  assert.deepEqual(ids(s.removed), ['p2/C']);
  assert.deepEqual(plain(s.removed[0]), { projectId: 'p2', projectName: 'Two', id: 'C', title: 'title C', size: 'L', points: 3 }, 'removed carries the planned ref');
  assert.deepEqual(plain(s.spillover[1]), { projectId: 'p2', projectName: 'Two', id: 'E', title: 'title E', size: 'S', points: 1 }, 'a member carries its size and points at close');
  assert.deepEqual(plain(s.unreadable), []);
  assert.deepEqual(plain(world.writes), [['p1', 'B', LABEL], ['p2', 'E', LABEL]], 'the label is removed from the two unfinished beads, in order, and from nothing else');
  assert.ok(!labelsOf(world, P1, 'B').includes(LABEL) && !labelsOf(world, P2, 'E').includes(LABEL));
  assert.ok(labelsOf(world, P1, 'A').includes(LABEL) && labelsOf(world, P2, 'D').includes(LABEL), 'closed members keep the label');
  assert.deepEqual(plain(await store.get(SID)), plain(sprint));
  await refused(run.closeSprint(SID, deps), 409, 'sprint_not_active');
}
// A writer that fails for B only: summary stored, state closing, pending is B; then a retry.
{
  const { world, store, deps, key } = await env(caseBeads(), { sprint: activeSprint([]) });
  world.writeFails.set(key('p1', 'B'), 'tracker is locked');
  const first = await run.closeSprint(SID, deps);
  assert.equal(first.sprint.state, 'closing');
  assert.equal(first.sprint.closedAt, null);
  assert.deepEqual(plain(first.remaining.map((r) => [r.projectId, r.id, r.message])), [['p1', 'B', 'tracker is locked']]);
  assert.deepEqual(ids(first.sprint.pending), ['p1/B'], 'pending holds exactly B');
  assert.ok(!labelsOf(world, P2, 'E').includes(LABEL), 'the bead after the failing one was still handled');
  assert.deepEqual(world.writes.map((w) => w[1]), ['B', 'E'], 'the pass went on after the failure');
  const stored = await store.get(SID);
  assert.ok(stored.summary, 'the summary is stored');
  assert.deepEqual(plain(stored), plain(first.sprint));

  // Between the two calls a bead changes status. The summary does not.
  world.beads.find((b) => b.local_id === 'B').status = 'closed';
  world.writeFails.clear();
  const reads = world.reads;
  const second = await run.closeSprint(SID, deps);
  assert.equal(world.reads, reads, 'a second close reads nothing: the summary is not recomputed');
  assert.equal(second.sprint.state, 'closed');
  assert.deepEqual(plain(second.sprint.summary), plain(first.sprint.summary), 'the summary is the one stored by the first call');
  assert.ok(second.sprint.summary.spillover.some((r) => r.id === 'B'), 'B stays in spillover');
  assert.deepEqual(world.writes.slice(2).map((w) => w[1]), ['B'], 'the retry touches only the pending bead');
  assert.ok(!labelsOf(world, P1, 'B').includes(LABEL));
}
// A bead the tracker no longer knows counts as handled.
{
  const { world, deps, key } = await env(caseBeads(), { sprint: activeSprint([]) });
  world.notFound.add(key('p1', 'B'));
  const { sprint, remaining } = await run.closeSprint(SID, deps);
  assert.deepEqual(plain(remaining), []);
  assert.equal(sprint.state, 'closed', 'a bead that is gone does not keep the close from completing');
  assert.deepEqual(ids(sprint.pending), []);
  assert.deepEqual(world.writes.map((w) => w[1]), ['B', 'E'], 'the pass went on past it');
}
// Unreadable projects at close.
{
  const { world, store, deps } = await env(caseBeads(), { sprint: activeSprint([]) });
  world.failed = [{ id: 'p2', name: 'Two', error: 'gone' }];
  const before = plain(await store.get(SID));
  const err = await refused(run.closeSprint(SID, deps), 409, 'projects_unreadable');
  assert.ok(err.message.includes('Two') && !err.message.includes('One'), err.message);
  assert.deepEqual(plain(await store.get(SID)), before, 'the record is unchanged');
  assert.deepEqual(world.writes, [], 'no label was touched');
}
{
  const { world, deps } = await env(caseBeads(), { sprint: activeSprint([]) });
  world.failed = [{ id: 'p9', name: 'Nine', error: 'gone' }];
  const { sprint } = await run.closeSprint(SID, deps);
  assert.equal(sprint.state, 'closed', 'a failed project that holds no planned bead does not stop the close');
  assert.deepEqual(plain(sprint.summary.unreadable), ['Nine']);
}
// Close refusals.
{
  const { deps } = await env(caseBeads());
  await refused(run.closeSprint(SID, deps), 409, 'sprint_not_active');
  await refused(run.closeSprint('2030-01-01', deps), 404, 'unknown_sprint');
}
// Two beads with the same id in two projects are never mixed up.
{
  const planned = (p, id) => ({ projectId: p.id, projectName: p.name, id, title: `title ${id}`, size: null, points: 0 });
  // p1/x and p2/x planned; p1/x is done, p2/x is not. p2/y labelled later, p1/y was planned and lost its label.
  const beads = [
    bead(P1, 'x', { status: 'closed' }), bead(P2, 'x'),
    bead(P2, 'y'), bead(P1, 'y', { labels: [] }),
  ];
  const { world, deps } = await env(beads, {
    sprint: { state: 'active', startedAt: 'x', planned: [planned(P1, 'x'), planned(P2, 'x'), planned(P1, 'y')] },
  });
  const { sprint } = await run.closeSprint(SID, deps);
  assert.deepEqual(ids(sprint.summary.done), ['p1/x']);
  assert.deepEqual(ids(sprint.summary.spillover), ['p2/x', 'p2/y']);
  assert.deepEqual(ids(sprint.summary.added), ['p2/y'], 'p2/y is not matched against the planned p1/y');
  assert.deepEqual(ids(sprint.summary.removed), ['p1/y'], 'p1/y is not matched against the member p2/y');
  assert.deepEqual(world.writes.map((w) => `${w[0]}/${w[1]}`), ['p2/x', 'p2/y'], 'the label leaves the right project\'s bead');
  assert.ok(labelsOf(world, P1, 'x').includes(LABEL), 'the done bead of the other project keeps its label');
}
// The summary is on disk before the first label is touched.
{
  const { world, store, deps } = await env(caseBeads(), { sprint: activeSprint([]) });
  let seen;
  const removeLabel = deps.removeLabel;
  deps.removeLabel = async (...args) => {
    if (!seen) seen = await store.get(SID);
    return removeLabel(...args);
  };
  await run.closeSprint(SID, deps);
  assert.equal(seen.state, 'closing', 'before the first removal the record says closing');
  assert.ok(seen.summary, 'and holds the summary');
  assert.deepEqual(ids(seen.pending), ['p1/B', 'p2/E'], 'and the beads still to handle');
  assert.equal(world.writes.length, 2);
}
// Two sprints started in the same moment: one starts and the other is refused. The rule has to
// hold when the record changes, not only before the projects are read, which takes long enough
// for a second start to slip in.
{
  const OTHER = '2026-12-15';
  const { deps, store } = await env([bead(P1, 'x'), bead(P1, 'y', { labels: [`sprint:${OTHER}`] })]);
  await store.create({ name: 'Other', start: OTHER, end: '2026-12-28', capacity: 10 });
  const results = await Promise.allSettled([run.startSprint(SID, deps), run.startSprint(OTHER, deps)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one of two simultaneous starts goes through');
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'another_sprint_running');
  assert.equal((await store.list()).filter((sp) => sp.state === 'active').length, 1, 'one sprint is active in the file');
}

console.log('PASS (unit): start and its refusals, planned set, summary, label pass, retry, not_found, unreadable projects, same ids, simultaneous starts');

// ---------------------------------------------------------------- server half
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
const BR = process.env.BR_BIN || 'br';
try { execFileSync(BR, ['--version'], { stdio: 'ignore' }); } catch {
  console.log('SKIP server half: br is not installed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}

const json = { 'Content-Type': 'application/json' };
const RO = { Cookie: 'scotty-viewer-mode=read-only' };
const registered = [];
const brIn = (cwd, args) => execFileSync(BR, args, { cwd, encoding: 'utf8' });
const stored = (cwd, id) => [...JSON.parse(brIn(cwd, ['show', id, '--json']))[0].labels ?? []].sort();
const register = async (dir) => {
  const res = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(res.status, 201, `register ${dir}: ${await res.clone().text()}`);
  const id = (await res.json()).id;
  registered.push(id);
  return id;
};
const call = (method, url, body, headers = {}) =>
  fetch(`${base}${url}`, { method, headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const label = async (projectId, beadId, add) => {
  const res = await call('POST', `/api/p/${projectId}/beads/${beadId}/labels`, { add });
  assert.equal(res.status, 200, await res.clone().text());
};
const createSprint = async (start, name) => {
  const res = await call('POST', '/api/sprints', { name, start, end: '2031-12-31', capacity: 10 });
  assert.equal(res.status, 201, await res.clone().text());
};

try {
  // Tracker A has two beads; B is a byte copy, so both trackers hold beads with the same ids.
  const a = tmp('scotty-run-a-');
  execFileSync('git', ['init', '-q'], { cwd: a });
  brIn(a, ['init', '--prefix', 'sp']);
  const create = (title) => JSON.parse(brIn(a, ['create', title, '--json'])).id;
  const x = create('stays open');
  const y = create('done in one tracker only');
  const b = path.join(tmp('scotty-run-b-'), 'copy');
  fs.cpSync(a, b, { recursive: true });
  const aId = await register(a);
  const bId = await register(b);

  const S1 = '2031-03-03';
  const S2 = '2031-03-04';
  await createSprint(S1, 'Run');
  await createSprint(S2, 'Other');

  // An empty sprint does not start, and neither does one that does not exist.
  let res = await call('POST', `/api/sprints/${S2}/start`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'sprint_empty');
  res = await call('POST', '/api/sprints/2030-01-01/start');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'unknown_sprint');
  res = await call('POST', '/api/sprints/2030-01-01/close');
  assert.equal(res.status, 404);

  // Label: x in A, y in A and y in B.
  const tag = `sprint:${S1}`;
  await label(aId, x, [tag, 'size:M']);
  await label(aId, y, [tag, 'size:S']);
  await label(bId, y, [tag]);

  // Read-only refuses both routes and changes nothing.
  for (const action of ['start', 'close']) {
    res = await call('POST', `/api/sprints/${S1}/${action}`, undefined, RO);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'read_only');
  }
  assert.equal((await (await call('GET', `/api/sprints/${S1}`)).json()).state, 'planned', 'read-only left the sprint planned');

  // A planned sprint cannot close.
  res = await call('POST', `/api/sprints/${S1}/close`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'sprint_not_active');

  // Start.
  res = await call('POST', `/api/sprints/${S1}/start`);
  assert.equal(res.status, 200, await res.clone().text());
  const started = await res.json();
  assert.equal(started.state, 'active');
  assert.ok(started.startedAt);
  assert.deepEqual(started.planned.map((r) => `${r.projectId}/${r.id}`).sort(), [`${aId}/${x}`, `${aId}/${y}`, `${bId}/${y}`].sort());
  assert.ok(started.planned.every((r) => r.title && r.projectName));
  const planned = (p, id) => started.planned.find((r) => r.projectId === p && r.id === id);
  assert.deepEqual([planned(aId, x).size, planned(aId, x).points, planned(aId, y).points], ['M', 2, 1]);

  // One sprint runs at a time; a started one does not start again.
  res = await call('POST', `/api/sprints/${S2}/start`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'another_sprint_running');
  res = await call('POST', `/api/sprints/${S1}/start`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'sprint_not_planned');

  // y is closed in A only.
  brIn(a, ['close', y]);

  // Tracker B cannot be written, as when its folder is read-only: the close stops halfway, names
  // the bead that is left with the tracker's own message, and keeps it in the record. B is
  // still read, because reading a tracker only opens its file.
  const writable = (dir, on) => {
    fs.chmodSync(path.join(dir, '.beads'), on ? 0o755 : 0o555);
    fs.chmodSync(path.join(dir, '.beads', 'beads.db'), on ? 0o644 : 0o444);
  };
  const refsOf = (refs) => refs.map((r) => `${r.projectId}/${r.id}`);
  let half;
  writable(b, false);
  try {
    res = await call('POST', `/api/sprints/${S1}/close`);
    assert.equal(res.status, 500, await res.clone().text());
    half = await res.json();
    assert.equal(half.code, 'close_incomplete');
    assert.deepEqual(refsOf(half.remaining), [`${bId}/${y}`], 'only the bead of the tracker that refused is left');
    assert.ok(half.remaining[0].message, 'the message of the tracker is passed on');
    assert.equal(half.sprint.state, 'closing');
    assert.deepEqual(refsOf(half.sprint.pending), [`${bId}/${y}`]);
    assert.ok(!stored(a, x).includes(tag), 'the bead of the tracker that could be written already lost the label');
    // A sprint that has not finished closing still counts as running.
    res = await call('POST', `/api/sprints/${S2}/start`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'another_sprint_running');
  } finally {
    writable(b, true);
  }
  assert.ok(stored(b, y).includes(tag), 'the bead of the tracker that refused still carries the label');

  // Asking again finishes the close and keeps what the first call recorded.
  res = await call('POST', `/api/sprints/${S1}/close`);
  assert.equal(res.status, 200, await res.clone().text());
  const closed = await res.json();
  assert.deepEqual(closed.summary, half.sprint.summary, 'the retry keeps the summary of the first call');
  assert.equal(closed.state, 'closed');
  assert.ok(closed.closedAt);
  assert.deepEqual(closed.pending, []);
  const at = (refs) => refs.map((r) => `${r.projectId}/${r.id}`).sort();
  assert.deepEqual(at(closed.summary.done), [`${aId}/${y}`]);
  assert.deepEqual(at(closed.summary.spillover), [`${aId}/${x}`, `${bId}/${y}`].sort());
  assert.deepEqual(closed.summary.added, []);
  assert.deepEqual(closed.summary.removed, []);
  assert.equal(closed.summary.plannedCount, 3);
  assert.equal(closed.summary.plannedPoints, 3);
  assert.deepEqual((await (await call('GET', `/api/sprints/${S1}`)).json()).summary, closed.summary, 'the record holds the summary');

  // The trackers: the closed bead kept the label, the unfinished ones lost it, the namesake in B too.
  assert.ok(stored(a, y).includes(tag), 'the closed bead keeps the label');
  assert.ok(!stored(a, x).includes(tag), 'the open bead lost it');
  assert.ok(!stored(b, y).includes(tag), 'the open bead of the other tracker with the same id lost it');
  assert.ok(stored(a, x).includes('size:M'), 'other labels are untouched');

  // Closed sprints do not close or start again; read-only still refuses.
  res = await call('POST', `/api/sprints/${S1}/close`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'sprint_not_active');
  res = await call('POST', `/api/sprints/${S1}/close`, undefined, RO);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'read_only');

  console.log('PASS (server): start, refusals, a close that stops halfway and its retry, summary, labels in both trackers, read-only');
} finally {
  for (const id of registered) await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
