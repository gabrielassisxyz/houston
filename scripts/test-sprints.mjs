// Sprint records. The first half is pure: lib/sprint-model.ts and lib/sprints.ts load without a
// build and the store runs against a file under os.tmpdir(). The second half needs
// SCOTTY_TEST_URL (an isolated server, which has a throwaway config directory of its own).
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
function load(name) {
  if (loaded[name]) return loaded[name];
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const req = (id) => (id === './sprint-model' ? load('sprint-model') : id === 'server-only' ? {} : require(id));
  vm.runInNewContext(code, { exports, require: req, structuredClone, Date, process }, { filename: name });
  return (loaded[name] = exports);
}
// Values built inside the vm context carry its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const rejects = async (promise, check) => {
  let caught;
  try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, 'expected a rejection');
  check?.(caught);
  return caught;
};

// ---------------------------------------------------------------- pure half: the model
const model = load('sprint-model');
for (const [label, points] of [['size:S', 1], ['size:M', 2], ['size:L', 3], ['size:XL', 5], ['size:huge', 0]]) {
  assert.equal(model.pointsOf(['x', label]), points, label);
}
assert.equal(model.pointsOf([]), 0);
assert.equal(model.sizeOf(['size:huge']), null);
assert.equal(model.sizeOf(['a']), null);
assert.equal(model.sizeOf(['size:huge', 'size:M']), 'M', 'the first label on the scale wins');
assert.equal(model.sizeOf(['size:toString']), null, 'a name from the prototype is not a size');
assert.equal(model.pointsOf(['size:XL']), 5);
assert.deepEqual(plain(model.sprintIdsOf(['a', 'sprint:2026-11-23', 'sprint:2026-11-30'])), ['2026-11-23', '2026-11-30']);
assert.equal(model.sprintLabel('2026-11-23'), 'sprint:2026-11-23');

const good = { name: 'Two weeks', start: '2026-11-23', end: '2026-12-06', capacity: 30 };
assert.equal(model.createSprintSchema.safeParse(good).success, true);
assert.equal(model.createSprintSchema.parse({ ...good, name: '  padded  ' }).name, 'padded', 'the name is trimmed');
assert.equal(model.createSprintSchema.safeParse({ ...good, end: good.start }).success, true, 'a one-day sprint is allowed');
assert.equal(model.createSprintSchema.safeParse({ ...good, capacity: 0 }).success, true);
assert.equal(model.createSprintSchema.safeParse({ ...good, capacity: 9999 }).success, true);
const bad = (patch, field) => {
  const res = model.createSprintSchema.safeParse({ ...good, ...patch });
  assert.equal(res.success, false, JSON.stringify(patch));
  assert.ok(res.error.issues.some((i) => i.path.includes(field) || (field === '' && i.path.length === 0)), `${JSON.stringify(patch)} names ${field}: ${JSON.stringify(res.error.issues)}`);
};
bad({ name: '' }, 'name');
bad({ name: '   ' }, 'name');
bad({ name: 'x'.repeat(81) }, 'name');
bad({ start: '2026-02-30' }, 'start');
bad({ end: '2026-02-30' }, 'end');
bad({ start: '2026-13-01' }, 'start');
bad({ start: '26-11-23' }, 'start');
bad({ end: '2026-11-22' }, 'end');
bad({ capacity: -1 }, 'capacity');
bad({ capacity: 1.5 }, 'capacity');
bad({ capacity: 10000 }, 'capacity');
bad({ extra: 1 }, '');
assert.equal(model.createSprintSchema.safeParse({ ...good, name: 'x'.repeat(80) }).success, true);
assert.equal(model.patchSprintSchema.safeParse({}).success, false, 'a patch needs a key');
for (const body of [{ start: '2026-11-24' }, { id: 'x' }, { state: 'closed' }, { capacity: 3, nope: 1 }]) {
  assert.equal(model.patchSprintSchema.safeParse(body).success, false, JSON.stringify(body));
}
assert.equal(model.patchSprintSchema.safeParse({ capacity: 3 }).success, true);

// ---------------------------------------------------------------- pure half: the store
const { createSprintStore, SprintError } = load('sprints');
const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sprints-')); dirs.push(d); return d; };
try {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'sprints.json');
  const store = createSprintStore(file);
  assert.deepEqual(plain(await store.list()), [], 'a missing file is an empty list');
  await rejects(store.get('2026-11-23'), (e) => assert.equal(e.code, 'unknown_sprint'));

  const made = await store.create(good);
  assert.equal(made.id, '2026-11-23');
  assert.equal(made.state, 'planned');
  assert.equal(made.planned, null);
  assert.deepEqual(plain(made.pending), []);
  assert.deepEqual(plain(await store.get(made.id)), plain(made));
  assert.deepEqual(plain(await store.list()), [plain(made)]);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.sprints.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sprints.json'], 'no temp file is left behind');

  await rejects(store.create(good), (e) => assert.equal(e.code, 'sprint_exists'));
  assert.equal((await store.list()).length, 1, 'a refused create writes nothing');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sprints.json']);

  const patched = await store.patch(made.id, { capacity: 12 });
  assert.equal(patched.capacity, 12);
  assert.deepEqual(plain({ ...patched, capacity: 0 }), plain({ ...made, capacity: 0 }), 'patch changes only the keys given');
  await rejects(store.patch(made.id, { end: '2026-11-01' }), (e) => assert.ok(e.issues?.some((i) => i.path[0] === 'end'), 'end before start'));
  await rejects(store.patch(made.id, {}), (e) => assert.ok(e.issues));
  await rejects(store.patch('2030-01-01', { capacity: 1 }), (e) => assert.equal(e.code, 'unknown_sprint'));

  // The ordering is by start date, not by when the record was written.
  await store.create({ ...good, start: '2026-11-09', end: '2026-11-20' });
  await store.create({ ...good, start: '2027-01-04', end: '2027-01-10' });
  assert.deepEqual(plain((await store.list()).map((s) => s.start)), ['2026-11-09', '2026-11-23', '2027-01-04']);

  // Nothing is cached: a record another process wrote is seen by the next call.
  const foreign = JSON.parse(fs.readFileSync(file, 'utf8'));
  foreign.sprints.push({ ...foreign.sprints[0], id: '2026-12-21', start: '2026-12-21', end: '2026-12-27', name: 'Other process' });
  fs.writeFileSync(file, JSON.stringify(foreign));
  assert.ok((await store.list()).some((s) => s.name === 'Other process'), 'list re-reads the file');
  assert.equal((await store.get('2026-12-21')).name, 'Other process', 'get re-reads the file');

  // mutate is one step and keeps the id.
  const mutated = await store.mutate('2026-12-21', (s) => ({ ...s, state: 'active', startedAt: 'now' }));
  assert.equal(mutated.state, 'active');
  assert.equal((await store.get('2026-12-21')).startedAt, 'now');
  await rejects(store.mutate('2026-12-21', (s) => ({ ...s, id: 'other' })));
  await rejects(store.mutate('2030-01-01', (s) => s), (e) => assert.equal(e.code, 'unknown_sprint'));

  // Closing and closing-in-progress sprints are neither edited nor deleted; an active one is not deleted.
  await rejects(store.remove('2026-12-21'), (e) => assert.equal(e.code, 'sprint_not_deletable'));
  assert.equal((await store.patch('2026-12-21', { name: 'Active can be renamed' })).name, 'Active can be renamed');
  for (const state of ['closing', 'closed']) {
    await store.mutate('2026-12-21', (s) => ({ ...s, state }));
    await rejects(store.patch('2026-12-21', { capacity: 1 }), (e) => assert.equal(e.code, 'sprint_not_editable', state));
    await rejects(store.remove('2026-12-21'), (e) => assert.equal(e.code, 'sprint_not_deletable', state));
  }

  await store.remove('2026-11-09');
  assert.ok(!(await store.list()).some((s) => s.id === '2026-11-09'), 'remove drops the sprint');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sprints.json']);

  // Twenty creates started together all land.
  const busy = createSprintStore(path.join(tmpDir(), 'sprints.json'));
  const days = Array.from({ length: 20 }, (_, i) => `2027-03-${String(i + 1).padStart(2, '0')}`);
  await Promise.all(days.map((d) => busy.create({ ...good, start: d, end: '2027-04-30' })));
  assert.deepEqual(plain((await busy.list()).map((s) => s.start)), days, 'twenty concurrent creates leave twenty sprints');
  assert.equal(JSON.parse(fs.readFileSync(busy.file, 'utf8')).sprints.length, 20);
  // A failing step does not stall the queue behind it.
  await rejects(busy.create(good.start && { ...good, start: days[0], end: '2027-04-30' }));
  await busy.create({ ...good, start: '2028-01-03', end: '2028-01-09' });
  assert.equal((await busy.list()).length, 21, 'the queue survives a refused step');

  // A damaged file is reported by path and left alone, whichever call finds it.
  for (const content of ['{not json', '{"version":1,"sprints":[{"id":1}]}', '{"version":2,"sprints":[]}']) {
    const damaged = path.join(tmpDir(), 'sprints.json');
    fs.writeFileSync(damaged, content);
    const broken = createSprintStore(damaged);
    const calls = {
      list: () => broken.list(),
      get: () => broken.get('2026-11-23'),
      create: () => broken.create(good),
      patch: () => broken.patch('2026-11-23', { capacity: 1 }),
      remove: () => broken.remove('2026-11-23'),
      mutate: () => broken.mutate('2026-11-23', (s) => s),
    };
    for (const [name, call] of Object.entries(calls)) {
      await rejects(call(), (e) => {
        assert.ok(e instanceof SprintError, `${name} on ${content}`);
        assert.equal(e.code, 'sprints_file_invalid');
        assert.ok(e.message.includes(damaged), `${name} names the file: ${e.message}`);
      });
    }
    assert.equal(fs.readFileSync(damaged, 'utf8'), content, 'the damaged file is untouched');
    assert.deepEqual(fs.readdirSync(path.dirname(damaged)), ['sprints.json']);
  }
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log('PASS (unit): size and label helpers, schemas, store round trip, ordering, no cache, concurrent creates, damaged file');

// ---------------------------------------------------------------- server half
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
const json = { 'Content-Type': 'application/json' };
const call = async (method, url, body, headers = {}) => {
  const res = await fetch(`${base}${url}`, { method, headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const RO = { Cookie: 'scotty-viewer-mode=read-only' };

// The server's config directory, read from the environment of the process that listens.
const port = new URL(base).port;
const pid = /pid=(\d+)/.exec(execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }))?.[1];
assert.ok(pid, `no process listens on port ${port}`);
const cfgHome = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('XDG_CONFIG_HOME='))?.slice(16);
assert.ok(cfgHome && cfgHome.startsWith(os.tmpdir()), `the server uses a throwaway config directory: ${cfgHome}`);
const serverFile = path.join(cfgHome, 'houston', 'sprints.json');
const serverStore = createSprintStore(serverFile);

{
  const first = await call('POST', '/api/sprints', { ...good, start: '2026-11-23' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.id, '2026-11-23');
  assert.equal(first.body.state, 'planned');
  await call('POST', '/api/sprints', { ...good, name: 'Earlier', start: '2026-11-09', end: '2026-11-20' });
  const listed = await call('GET', '/api/sprints');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sprints.map((s) => s.start), ['2026-11-09', '2026-11-23'], 'ordered by start');

  const dup = await call('POST', '/api/sprints', good);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'sprint_exists');
  for (const body of [{ ...good, start: '2026-02-30' }, { ...good, end: '2026-11-01', start: '2026-11-24' }, { ...good, extra: 1 }, { ...good, name: '' }]) {
    const res = await call('POST', '/api/sprints', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'invalid_input');
  }
  const notJson = await fetch(`${base}/api/sprints`, { method: 'POST', headers: json, body: '{nope' });
  assert.equal(notJson.status, 400);

  const one = await call('GET', '/api/sprints/2026-11-23');
  assert.equal(one.status, 200);
  assert.equal(one.body.name, good.name);

  const patched = await call('PATCH', '/api/sprints/2026-11-23', { capacity: 30 });
  assert.equal(patched.status, 200);
  assert.deepEqual({ ...patched.body, capacity: 0 }, { ...first.body, capacity: 0 }, 'only the capacity changed');
  assert.equal(patched.body.capacity, 30);
  for (const body of [{ start: '2026-11-24' }, { id: 'x' }, { state: 'closed' }, { nope: 1 }, {}, { end: '2026-11-01' }]) {
    const res = await call('PATCH', '/api/sprints/2026-11-23', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'invalid_input');
  }
  assert.equal((await call('GET', '/api/sprints/2026-11-23')).body.capacity, 30, 'refused patches changed nothing');

  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const res = await call(method, '/api/sprints/1999-01-01', method === 'PATCH' ? { capacity: 1 } : undefined);
    assert.equal(res.status, 404, method);
    assert.equal(res.body.code, 'unknown_sprint');
  }

  // A closed sprint: the state is set through the store on the server's own file.
  await serverStore.mutate('2026-11-09', (s) => ({ ...s, state: 'closed', closedAt: new Date().toISOString() }));
  const edit = await call('PATCH', '/api/sprints/2026-11-09', { capacity: 1 });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'sprint_not_editable');
  const del = await call('DELETE', '/api/sprints/2026-11-09');
  assert.equal(del.status, 409);
  assert.equal(del.body.code, 'sprint_not_deletable');

  // The read-only cookie refuses writes on both routes and changes nothing.
  const before = fs.readFileSync(serverFile, 'utf8');
  for (const [method, url, body] of [
    ['POST', '/api/sprints', { ...good, start: '2030-01-07', end: '2030-01-13' }],
    ['PATCH', '/api/sprints/2026-11-23', { capacity: 1 }],
    ['DELETE', '/api/sprints/2026-11-23'],
  ]) {
    const res = await call(method, url, body, RO);
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal(res.body.code, 'read_only');
  }
  assert.equal(fs.readFileSync(serverFile, 'utf8'), before, 'the refused writes changed nothing');
  assert.equal((await call('GET', '/api/sprints', undefined, RO)).status, 200);
  assert.equal((await call('GET', '/api/sprints/2026-11-23', undefined, RO)).status, 200);
  assert.equal((await call('DELETE', '/api/sprints/2026-11-23', undefined, { Cookie: 'scotty-viewer-mode=editing' })).status, 200, 'editing mode may delete');

  const gone = await call('GET', '/api/sprints');
  assert.deepEqual(gone.body.sprints.map((s) => s.start), ['2026-11-09'], 'delete removed the planned sprint');

  // A damaged file is a 500 that names the file, on every route, and is not rewritten.
  fs.writeFileSync(serverFile, '{not json');
  for (const [method, url, body] of [
    ['GET', '/api/sprints'], ['POST', '/api/sprints', good], ['GET', '/api/sprints/2026-11-23'],
    ['PATCH', '/api/sprints/2026-11-23', { capacity: 1 }], ['DELETE', '/api/sprints/2026-11-23'],
  ]) {
    const res = await call(method, url, body);
    assert.equal(res.status, 500, `${method} ${url}`);
    assert.equal(res.body.code, 'sprints_file_invalid');
    assert.ok(res.body.error.includes(serverFile), res.body.error);
  }
  assert.equal(fs.readFileSync(serverFile, 'utf8'), '{not json');
  fs.rmSync(serverFile);
}
console.log('PASS (server): create, list order, conflicts, validation, 404s, closed sprint, read-only guard, damaged file');
