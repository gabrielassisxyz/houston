// Adding and removing single labels on a bead. The first half is pure: the bd store's refusal,
// with lib/bd.ts loaded without a build and its command runner stubbed to fail the test. The
// second half needs SCOTTY_TEST_URL (an isolated server) and a throwaway br tracker; it skips
// when br is not installed.
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
  const req = (id) => (id === './schema' ? load('schema') : id in stubs ? stubs[id] : require(id));
  vm.runInNewContext(code, { exports, require: req, process: { env: {} }, console });
  return (loaded[name] = exports);
}

// ---------------------------------------------------------------- pure half
{
  const commands = [];
  const execFile = (...args) => {
    commands.push(args.slice(0, 2));
    throw new Error('the bd store must not run a command to refuse a label edit');
  };
  const { createBdStore } = load('bd', { 'server-only': {}, 'node:child_process': { execFile } });
  const store = createBdStore('/nonexistent');
  assert.equal(typeof store.editLabels, 'function', 'the bd store has editLabels');
  let err;
  try {
    await store.editLabels('bd-1', { add: ['x'], remove: [] }, 'actor');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'editLabels on bd rejects');
  assert.equal(err.name, 'BdError', 'the refusal is a BdError');
  assert.equal(err.code, 'unsupported');
  assert.match(err.message, /label edits are not supported on bd-tracked projects/i);
  assert.deepEqual(commands, [], 'no command was run');
}
console.log('PASS (unit): bd store refuses label edits without running a command');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-lbl-'));
const json = { 'Content-Type': 'application/json' };
let projectId;
try {
  // cwd is always the throwaway directory: br resolves its tracker from there.
  const br = (args) => execFileSync(BR, args, { cwd: dir, encoding: 'utf8' });
  const create = (title, extra = []) => JSON.parse(br(['create', title, '--json', ...extra])).id;
  const stored = (id) => [...JSON.parse(br(['show', id, '--json']))[0].labels].sort();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  br(['init', '--prefix', 'lb']);

  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(added.status, 201);
  projectId = (await added.json()).id;

  const post = (root, id, body, headers = {}) =>
    fetch(`${base}/api/p/${root}/beads/${id}/labels`, {
      method: 'POST',
      headers: { ...json, ...headers },
      body: JSON.stringify(body),
    });
  const edit = (id, body) => post(projectId, id, body);
  const sorted = (b) => [...b.labels].sort();

  // Add, remove, and both at once.
  const bead = create('label target');
  let res = await edit(bead, { add: ['one'] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sorted(await res.json()), ['one']);
  res = await edit(bead, { remove: ['one'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), []);
  br(['label', 'add', bead, 'b']);
  res = await edit(bead, { add: ['a'], remove: ['b'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), ['a'], 'one request adds a and removes b');
  assert.deepEqual(stored(bead), ['a'], 'the tracker agrees');

  // Repeating an add, and removing what is absent, are no-ops.
  res = await edit(bead, { add: ['a'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), ['a'], 'a repeated add leaves the label once');
  res = await edit(bead, { remove: ['absent'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), ['a'], 'removing an absent label changes nothing');

  // A label written from a terminal in between is not lost.
  const racy = create('terminal in between');
  assert.equal((await edit(racy, { add: ['first'] })).status, 200);
  br(['update', racy, '--add-label=from-cli']);
  res = await edit(racy, { add: ['second'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), ['first', 'from-cli', 'second']);
  assert.deepEqual(stored(racy), ['first', 'from-cli', 'second']);

  // Eight requests together all land.
  const busy = create('eight at once');
  const names = Array.from({ length: 8 }, (_, i) => `par-${i}`);
  const answers = await Promise.all(names.map((l) => edit(busy, { add: [l] })));
  assert.deepEqual(answers.map((r) => r.status), Array(8).fill(200), 'all eight answer 200');
  assert.deepEqual(stored(busy), names, 'all eight labels are on the bead');

  // A closed bead accepts both.
  const closed = create('closed one');
  br(['label', 'add', closed, 'old']);
  br(['close', closed]);
  assert.equal((await edit(closed, { add: ['late'] })).status, 200);
  res = await edit(closed, { remove: ['old'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted(await res.json()), ['late']);

  // Bad bodies: 400 invalid_input, bead unchanged.
  const keep = create('stays as it is');
  br(['label', 'add', keep, 'keep']);
  const bad = [
    [{ add: ['sprint 1'] }, 'sprint 1'],
    [{ add: ['a,b'] }, 'a,b'],
    [{ add: [''] }],
    [{ add: ['x'], remove: ['x'] }],
    [{}],
    [{ add: [] }],
    [{ add: ['x'], extra: 1 }],
    [{ add: ['x'.repeat(101)] }],
  ];
  for (const [body, named] of bad) {
    res = await edit(keep, body);
    const out = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 40)}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'invalid_input');
    if (named) {
      assert.ok(out.issues.some((i) => i.path.join('.').startsWith('add') && i.path.length === 2), 'an issue points at the label');
      assert.ok(JSON.stringify(out.issues).includes('label'), 'the issues talk about the label');
    }
    assert.deepEqual(stored(keep), ['keep'], `unchanged after ${JSON.stringify(body).slice(0, 40)}`);
  }
  // The refusal comes from this route, not from br: the offending label's position is in the issue.
  res = await edit(keep, { add: ['ok', 'sprint 1'] });
  const positioned = await res.json();
  assert.deepEqual(positioned.issues.map((i) => i.path), [['add', 1]], 'the issue names the offending entry');
  assert.deepEqual(stored(keep), ['keep'], 'no partial write when one label is invalid');

  // Unknown bead / project.
  res = await edit('lb-nope', { add: ['x'] });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'not_found', 'unknown bead on br');
  res = await post('demo', 'bd-nope-nope', { add: ['x'] });
  assert.equal(res.status, 404, 'unknown bead on demo');
  assert.equal((await res.json()).code, 'not_found');
  res = await post('no-such-project', 'x', { add: ['x'] });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'unknown_project');

  // Demo project: add then remove, reflected by the list.
  const demoList = async () => (await (await fetch(`${base}/api/p/demo/beads`)).json()).beads;
  const target = (await demoList()).find((b) => (b.labels ?? []).length > 0);
  assert.ok(target, 'the demo data has a bead with labels');
  const before = [...target.labels];
  res = await post('demo', target.id, { add: ['zz-added'] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(sorted(await res.json()), [...before, 'zz-added'].sort(), 'demo add keeps the existing labels');
  assert.deepEqual(sorted((await demoList()).find((b) => b.id === target.id)), [...before, 'zz-added'].sort(), 'list reflects the add');
  res = await post('demo', target.id, { add: ['zz-twice', 'zz-twice'] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).labels.filter((l) => l === 'zz-twice').length, 1, 'a label named twice in one request is added once');
  res = await post('demo', target.id, { remove: ['zz-added', 'zz-twice'] });
  assert.equal(res.status, 200);
  assert.deepEqual(sorted((await demoList()).find((b) => b.id === target.id)), [...before].sort(), 'list reflects the remove');

  // Read-only mode refuses and changes nothing.
  res = await post(projectId, keep, { add: ['nope'] }, { Cookie: 'scotty-viewer-mode=read-only' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'read_only');
  assert.deepEqual(stored(keep), ['keep'], 'read-only left the labels alone');

  console.log('PASS (server): add/remove, idempotence, terminal write kept, 8 in parallel, closed bead, bad bodies, 404s, demo, read-only');
} finally {
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
