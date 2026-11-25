// Pure half: one child process per case with throwaway config and working dirs.
// Server half: under SCOTTY_TEST_URL, drives PATCH /api/projects/[id].
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const REPO = 'org/repo-a';
const REPO_B = 'org/repo-b';
const T = '2026-09-01T00:00:00Z';

// Child entry: re-executes this script with SCOTTY_PIPE_CHILD set. Runs first,
// before any parent setup.
if (process.env.SCOTTY_PIPE_CHILD) {
  const loaded = {};
  function load(name) {
    if (loaded[name]) return loaded[name];
    const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports = {};
    const req = (id) => {
      if (id === 'server-only') return {};
      if (id.startsWith('./')) return load(id.slice(2));
      return require(id);
    };
    vm.runInNewContext(code, { exports, require: req, structuredClone, Date, process, console, URL }, { filename: name });
    return (loaded[name] = exports);
  }
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const config = load('config');
  const xdg = process.env.XDG_CONFIG_HOME;
  const cfgFile = path.join(xdg, 'houston', 'config.json');
  const which = process.env.SCOTTY_PIPE_CHILD;
  const entry = (extra = {}) => ({
    id: 'alpha',
    name: 'Alpha',
    path: '/tmp/alpha',
    addedAt: T,
    lastOpened: T,
    ...extra,
  });

  if (which === 'valid-keep') {
    const c = config.getConfig();
    assert.equal(c.projects.length, 1);
    assert.equal(c.projects[0].pipelineRepo, REPO, 'valid value on disk is kept');
    assert.ok(Object.hasOwn(c.projects[0], 'pipelineRepo'));
    const d = config.getConfig();
    assert.equal(d.projects[0].pipelineRepo, REPO, 'second read keeps it');
  } else if (which === 'invalid-repo') {
    const a = config.getConfig();
    assert.equal(a.projects.length, 1);
    assert.ok(!Object.hasOwn(a.projects[0], 'pipelineRepo'), 'invalid repository is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b.projects[0], 'pipelineRepo'), 'second read still leaves it out');
  } else if (which === 'invalid-empty') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a.projects[0], 'pipelineRepo'), 'empty string is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b.projects[0], 'pipelineRepo'));
  } else if (which === 'invalid-null') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a.projects[0], 'pipelineRepo'), 'null is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b.projects[0], 'pipelineRepo'));
  } else if (which === 'absent') {
    const c = config.getConfig();
    assert.equal(c.projects.length, 1);
    assert.ok(!Object.hasOwn(c.projects[0], 'pipelineRepo'), 'absent leaves no own property');
  } else if (which === 'kept') {
    const before = config.getConfig();
    assert.equal(before.projects[0].pipelineRepo, REPO);
    config.saveConfig({ pollIntervalMs: 15000 });
    const after = config.getConfig();
    assert.equal(after.projects[0].pipelineRepo, REPO, 'an unrelated write keeps the value');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.projects[0].pipelineRepo, REPO, 'an unrelated write keeps the value on disk');
  } else if (which === 'update-sets') {
    const before = config.getConfig();
    assert.ok(!Object.hasOwn(before.projects[0], 'pipelineRepo'), 'starts absent');
    const out = config.updateProject('alpha', { pipelineRepo: REPO_B });
    assert.equal(out.pipelineRepo, REPO_B, 'update sets the value');
    assert.equal(config.getConfig().projects[0].pipelineRepo, REPO_B);
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.projects[0].pipelineRepo, REPO_B, 'the file records the value');
  } else if (which === 'update-clears') {
    const before = config.getConfig();
    assert.equal(before.projects[0].pipelineRepo, REPO);
    const out = config.updateProject('alpha', { pipelineRepo: '' });
    assert.ok(!Object.hasOwn(out, 'pipelineRepo'), 'clearing leaves no own property in memory');
    assert.ok(!Object.hasOwn(config.getConfig().projects[0], 'pipelineRepo'));
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!Object.hasOwn(onDisk.projects[0], 'pipelineRepo'), 'clearing leaves no own property on disk');
  } else if (which === 'update-refuses') {
    const before = config.getConfig();
    assert.equal(before.projects[0].name, 'Alpha');
    assert.equal(before.projects[0].pipelineRepo, REPO);
    const beforeBytes = fs.readFileSync(cfgFile, 'utf8');
    let caught = null;
    try {
      config.updateProject('alpha', { name: 'New', pipelineRepo: 'bad' });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'an invalid repository throws');
    assert.equal(caught.code, 'invalid_config', 'refusal carries code invalid_config');
    assert.ok(caught instanceof config.ConfigError, 'refusal is a ConfigError');
    const after = config.getConfig();
    assert.equal(after.projects[0].name, 'Alpha', 'the name is unchanged');
    assert.equal(after.projects[0].pipelineRepo, REPO, 'the repository is unchanged');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeBytes, 'the file is byte-for-byte unchanged');
  } else if (which === 'update-unknown') {
    const out = config.updateProject('missing', { pipelineRepo: REPO });
    assert.equal(out, undefined, 'unknown id answers undefined');
  } else if (which === 'update-rename-keeps') {
    const before = config.getConfig();
    assert.equal(before.projects[0].pipelineRepo, REPO);
    const out = config.updateProject('alpha', { name: 'Renamed' });
    assert.equal(out.name, 'Renamed', 'rename applies');
    assert.equal(out.pipelineRepo, REPO, 'rename keeps the repository');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.projects[0].name, 'Renamed');
    assert.equal(onDisk.projects[0].pipelineRepo, REPO);
  } else {
    throw new Error(`unknown child case ${which}`);
  }
  // Every child asserts it ran without a .beads folder via the parent check.
  void entry;
  void plain;
  process.exit(0);
}

// Parent: pure half.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-pipe-'));
const isolatedGit = { GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' };
function runCase(name, { onDisk } = {}) {
  const xdg = fs.mkdtempSync(path.join(scratch, 'xdg-'));
  fs.mkdirSync(path.join(xdg, 'houston'), { recursive: true });
  if (onDisk !== undefined) {
    fs.writeFileSync(path.join(xdg, 'houston', 'config.json'), JSON.stringify(onDisk));
  }
  const work = fs.mkdtempSync(path.join(scratch, 'work-'));
  const childEnv = { ...process.env, ...isolatedGit, XDG_CONFIG_HOME: xdg, SCOTTY_PIPE_CHILD: name };
  delete childEnv.BEADS_ACTOR;
  delete childEnv.BEADS_REPO;
  delete childEnv.SCOTTY_TEST_URL;
  const res = spawnSync(process.execPath, [scriptPath], { cwd: work, env: childEnv, encoding: 'utf8' });
  assert.equal(res.status, 0, `${name} exited ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
  assert.ok(!fs.existsSync(path.join(work, '.beads')), `${name} ran without a .beads folder`);
  return res;
}
function countFor(stderr, key) {
  return stderr.split(`[houston] config: ${key} ignored:`).length - 1;
}
const proj = (extra = {}) => ({ id: 'alpha', name: 'Alpha', path: '/tmp/alpha', addedAt: T, lastOpened: T, ...extra });

try {
  runCase('valid-keep', { onDisk: { projects: [proj({ pipelineRepo: REPO })] } });

  let res = runCase('invalid-repo', { onDisk: { projects: [proj({ pipelineRepo: 'Org/repo-a' })] } });
  assert.equal(countFor(res.stderr, 'pipelineRepo'), 1, 'invalid repository warns exactly once');
  res = runCase('invalid-empty', { onDisk: { projects: [proj({ pipelineRepo: '' })] } });
  assert.equal(countFor(res.stderr, 'pipelineRepo'), 1, 'empty string warns exactly once');
  res = runCase('invalid-null', { onDisk: { projects: [proj({ pipelineRepo: null })] } });
  assert.equal(countFor(res.stderr, 'pipelineRepo'), 1, 'null warns exactly once');

  res = runCase('absent', { onDisk: { projects: [proj()] } });
  assert.equal(countFor(res.stderr, 'pipelineRepo'), 0, 'absent warns never');

  runCase('kept', { onDisk: { projects: [proj({ pipelineRepo: REPO })], pollIntervalMs: 30000 } });
  runCase('update-sets', { onDisk: { projects: [proj()] } });
  runCase('update-clears', { onDisk: { projects: [proj({ pipelineRepo: REPO })] } });
  runCase('update-refuses', { onDisk: { projects: [proj({ pipelineRepo: REPO })] } });
  runCase('update-unknown', { onDisk: { projects: [proj()] } });
  runCase('update-rename-keeps', { onDisk: { projects: [proj({ pipelineRepo: REPO })] } });

  console.log('PASS (unit): pipelineRepo kept, dropped with a warning, surviving writes; updateProject sets, clears and refuses');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// Server half.
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
const BR = process.env.BR_BIN || 'br';
try {
  execFileSync(BR, ['--version'], { stdio: 'ignore' });
} catch {
  console.log('SKIP server half: br is not installed');
  process.exit(0);
}

const json = { 'Content-Type': 'application/json' };
const dirs = [];
const registered = [];
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const brIn = (cwd, args) => execFileSync(BR, args, { cwd, encoding: 'utf8' });
const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

try {
  const dir = tmp('scotty-pipe-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  brIn(dir, ['init', '--prefix', 'pp']);
  brIn(dir, ['create', 'pipeline probe', '--json']);
  const added = await call('POST', '/api/projects', { path: dir });
  assert.equal(added.status, 201, `register ${dir}: ${JSON.stringify(added.body)}`);
  const id = added.body.id;
  registered.push(id);
  const initialName = added.body.name;
  assert.ok(initialName, 'registration answers a name');

  // PATCH sets.
  let patched = await call('PATCH', `/api/projects/${id}`, { pipelineRepo: REPO });
  assert.equal(patched.status, 200, `set: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.pipelineRepo, REPO, 'PATCH answers the value');

  // GET /api/projects and the doctor route carry it.
  let listed = await call('GET', '/api/projects');
  assert.equal(listed.status, 200);
  const listedEntry = listed.body.projects.find((p) => p.id === id);
  assert.ok(listedEntry, 'the project is listed');
  assert.equal(listedEntry.pipelineRepo, REPO, 'GET /api/projects carries the value');
  let doctor = await call('GET', `/api/p/${id}/doctor`);
  assert.equal(doctor.status, 200, `doctor: ${JSON.stringify(doctor.body)}`);
  assert.equal(doctor.body.project?.pipelineRepo, REPO, 'the doctor route carries the value');

  // An invalid repository is refused.
  patched = await call('PATCH', `/api/projects/${id}`, { pipelineRepo: 'Org/repo-a' });
  assert.equal(patched.status, 400, `invalid: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.code, 'invalid_config', 'invalid answers code invalid_config');

  // An invalid repository sent with a new name changes neither.
  patched = await call('PATCH', `/api/projects/${id}`, { name: 'Brand New', pipelineRepo: 'bad' });
  assert.equal(patched.status, 400, `invalid with name: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.code, 'invalid_config');
  listed = await call('GET', '/api/projects');
  const afterBad = listed.body.projects.find((p) => p.id === id);
  assert.equal(afterBad.name, initialName, 'a refused write leaves the name unchanged');
  assert.equal(afterBad.pipelineRepo, REPO, 'a refused write leaves the repository unchanged');

  // {} is invalid input.
  patched = await call('PATCH', `/api/projects/${id}`, {});
  assert.equal(patched.status, 400, `empty: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.code, 'invalid_input', 'empty patch answers invalid_input');

  // A blank name is invalid input.
  patched = await call('PATCH', `/api/projects/${id}`, { name: '   ' });
  assert.equal(patched.status, 400, `blank name: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.code, 'invalid_input');

  // { name } renames and keeps pipelineRepo.
  patched = await call('PATCH', `/api/projects/${id}`, { name: 'Renamed' });
  assert.equal(patched.status, 200, `rename: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.name, 'Renamed', 'PATCH renames');
  assert.equal(patched.body.pipelineRepo, REPO, 'rename keeps the repository');
  listed = await call('GET', '/api/projects');
  const renamed = listed.body.projects.find((p) => p.id === id);
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.pipelineRepo, REPO);

  // PATCH clears with an empty string.
  patched = await call('PATCH', `/api/projects/${id}`, { pipelineRepo: '' });
  assert.equal(patched.status, 200, `clear: ${JSON.stringify(patched.body)}`);
  assert.ok(!Object.hasOwn(patched.body, 'pipelineRepo'), 'clearing leaves no own property');
  listed = await call('GET', '/api/projects');
  const cleared = listed.body.projects.find((p) => p.id === id);
  assert.ok(!Object.hasOwn(cleared, 'pipelineRepo'), 'GET /api/projects has no property after clear');
  doctor = await call('GET', `/api/p/${id}/doctor`);
  assert.equal(doctor.status, 200);
  assert.ok(!('pipelineRepo' in (doctor.body.project ?? {})), 'the doctor omits the key after clear');

  // Unknown id answers 404.
  patched = await call('PATCH', '/api/projects/no-such-project', { pipelineRepo: REPO });
  assert.equal(patched.status, 404, `unknown: ${JSON.stringify(patched.body)}`);

  console.log('PASS (server): PATCH sets, refuses, renames, clears; projects and doctor carry the value; unknown 404');
} finally {
  for (const rid of registered) {
    await fetch(`${base}/api/projects/${rid}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
