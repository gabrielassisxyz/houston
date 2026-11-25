// Pure half: one child process per case with throwaway config and working dirs.
// Server half: under SCOTTY_TEST_URL, drives the config route.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const VALID = 'http://127.0.0.1:8000/';
const VALID_BARE = 'http://127.0.0.1:8000';
const SNAP = '/snapshots/chain.json';
const HOST = 'example.com';
const ORGS = ['org-a'];

// Child entry: re-executes this script with SCOTTY_WORK_CHILD set. Runs first,
// before any parent setup.
if (process.env.SCOTTY_WORK_CHILD) {
  process.umask(0o022);
  assert.equal(process.umask(), 0o022, 'umask is 022');
  const renameFail = process.env.SCOTTY_WORK_RENAME_FAIL === '1';
  const loaded = {};
  function load(name) {
    if (loaded[name]) return loaded[name];
    const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports = {};
    const realFs = require('node:fs');
    const req = (id) => {
      if (id === 'server-only') return {};
      if (id.startsWith('./')) return load(id.slice(2));
      if (renameFail && (id === 'node:fs' || id === 'fs')) {
        return { ...realFs, renameSync: () => { throw new Error('rename failed for test'); } };
      }
      return require(id);
    };
    vm.runInNewContext(code, { exports, require: req, structuredClone, Date, process, console, URL }, { filename: name });
    return (loaded[name] = exports);
  }
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const config = load('config');
  const xdg = process.env.XDG_CONFIG_HOME;
  const cfgFile = path.join(xdg, 'houston', 'config.json');
  const cfgDir = path.join(xdg, 'houston');
  const which = process.env.SCOTTY_WORK_CHILD;

  if (which === 'valid-read') {
    const c = config.getConfig();
    assert.equal(c.workDashboardUrl, VALID, 'valid value on disk is read, normalised');
    assert.ok(Object.hasOwn(c, 'workDashboardUrl'));
  } else if (which === 'invalid-string') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a, 'workDashboardUrl'), 'invalid string is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b, 'workDashboardUrl'), 'second read still leaves it out');
  } else if (which === 'invalid-null') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a, 'workDashboardUrl'), 'null is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b, 'workDashboardUrl'));
  } else if (which === 'invalid-empty') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a, 'workDashboardUrl'), 'empty string is left out');
    const b = config.getConfig();
    assert.ok(!Object.hasOwn(b, 'workDashboardUrl'));
  } else if (which === 'absent') {
    const c = config.getConfig();
    assert.ok(!Object.hasOwn(c, 'workDashboardUrl'), 'absent leaves no own property');
  } else if (which === 'corrupt-null' || which === 'corrupt-array' || which === 'corrupt-string') {
    const c = config.getConfig();
    assert.deepEqual(plain(c.projects), []);
    assert.ok(!Object.hasOwn(c, 'workDashboardUrl'));
  } else if (which === 'persist-corrupt-string' || which === 'persist-array') {
    config.saveConfig({ pollIntervalMs: 15000 });
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!('0' in onDisk) && !('1' in onDisk), 'no index keys from a corrupt file');
    assert.equal(onDisk.pollIntervalMs, 15000);
    assert.ok(typeof onDisk === 'object' && onDisk !== null && !Array.isArray(onDisk), 'a plain object is written');
  } else if (which === 'mode-0600') {
    config.saveConfig({ pollIntervalMs: 15000 });
    const st = fs.statSync(cfgFile);
    assert.equal(st.mode & 0o777, 0o600, 'file has mode 0600');
    assert.deepEqual(fs.readdirSync(cfgDir), ['config.json'], 'no temporary file remains');
  } else if (which === 'merge-order') {
    config.getConfig();
    const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cur.handKey = 'kept';
    cur.workDashboardUrl = VALID;
    fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2));
    config.saveConfig({ pollIntervalMs: 15000 });
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(after.handKey, 'kept', 'hand-added key survives');
    assert.equal(after.workDashboardUrl, VALID, 'hand-added dashboard url survives');
    assert.equal(after.pollIntervalMs, 15000, 'in-memory value wins over disk');
  } else if (which === 'undefined-ignored') {
    const before = config.getConfig();
    assert.equal(before.workDashboardUrl, VALID);
    config.saveConfig({ pollIntervalMs: 15000, workDashboardUrl: undefined });
    const after = config.getConfig();
    assert.equal(after.workDashboardUrl, VALID, 'undefined patch leaves the url intact in memory');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.workDashboardUrl, VALID, 'undefined patch leaves the url intact on disk');
    assert.equal(onDisk.pollIntervalMs, 15000);
  } else if (which === 'null-removes') {
    const before = config.getConfig();
    assert.equal(before.workDashboardUrl, VALID);
    config.saveConfig({ workDashboardUrl: null });
    const after = config.getConfig();
    assert.ok(!Object.hasOwn(after, 'workDashboardUrl'), 'removal leaves no own property');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!Object.hasOwn(onDisk, 'workDashboardUrl'), 'removal clears the file');
  } else if (which === 'invalid-save') {
    const beforeBytes = fs.readFileSync(cfgFile, 'utf8');
    const before = config.getConfig();
    assert.equal(before.workDashboardUrl, VALID);
    assert.equal(before.pollIntervalMs, 30000);
    let caught = null;
    try {
      config.saveConfig({ pollIntervalMs: 15000, workDashboardUrl: 'http://localhost/' });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'an invalid url throws');
    assert.equal(caught.code, 'invalid_config', 'refusal carries code invalid_config');
    assert.ok(caught instanceof config.ConfigError, 'refusal is a ConfigError');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeBytes, 'the file is byte-for-byte unchanged');
    const after = config.getConfig();
    assert.equal(after.pollIntervalMs, 30000, 'poll interval is unchanged');
    assert.equal(after.workDashboardUrl, VALID, 'dashboard url is unchanged');
  } else if (which === 'rename-fail') {
    const beforeBytes = fs.readFileSync(cfgFile, 'utf8');
    config.getConfig();
    let threw = false;
    try {
      config.saveConfig({ pollIntervalMs: 15000 });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'saveConfig does not throw when the rename fails');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeBytes, 'the old file bytes are unchanged');
    assert.deepEqual(fs.readdirSync(cfgDir), ['config.json'], 'no temporary file remains');
    assert.equal(config.getConfig().pollIntervalMs, 15000, 'the new value stays in memory');
  } else if (which === 'save-normalises') {
    config.saveConfig({ workDashboardUrl: VALID_BARE });
    assert.equal(config.getConfig().workDashboardUrl, VALID, 'saveConfig normalises');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.workDashboardUrl, VALID, 'the file records the normalised url');
  } else if (which === 'chain-valid-read') {
    const c = config.getConfig();
    assert.equal(c.snapshotPath, SNAP, 'valid snapshot path on disk is read');
    assert.ok(Object.hasOwn(c, 'snapshotPath'));
    assert.equal(c.serviceNowHost, HOST, 'valid host on disk is read');
    assert.ok(Object.hasOwn(c, 'serviceNowHost'));
    assert.deepEqual(plain(c.githubOrgs), ORGS, 'valid owners on disk are read');
    assert.ok(Object.hasOwn(c, 'githubOrgs'));
  } else if (which === 'chain-invalid-snapshot' || which === 'chain-invalid-host' || which === 'chain-invalid-orgs' || which === 'chain-invalid-orgs-list') {
    const a = config.getConfig();
    assert.ok(!Object.hasOwn(a, 'snapshotPath') || which !== 'chain-invalid-snapshot', 'invalid snapshot is left out');
    assert.ok(!Object.hasOwn(a, 'serviceNowHost') || which !== 'chain-invalid-host', 'invalid host is left out');
    if (which === 'chain-invalid-orgs' || which === 'chain-invalid-orgs-list') {
      assert.ok(!Object.hasOwn(a, 'githubOrgs'), 'invalid owners are ignored whole');
    }
    const b = config.getConfig();
    if (which === 'chain-invalid-snapshot') assert.ok(!Object.hasOwn(b, 'snapshotPath'), 'second read still leaves it out');
    if (which === 'chain-invalid-host') assert.ok(!Object.hasOwn(b, 'serviceNowHost'), 'second read still leaves it out');
    if (which === 'chain-invalid-orgs' || which === 'chain-invalid-orgs-list') assert.ok(!Object.hasOwn(b, 'githubOrgs'));
  } else if (which === 'chain-absent') {
    const c = config.getConfig();
    assert.ok(!Object.hasOwn(c, 'snapshotPath'), 'absent snapshot leaves no own property');
    assert.ok(!Object.hasOwn(c, 'serviceNowHost'), 'absent host leaves no own property');
    assert.ok(!Object.hasOwn(c, 'githubOrgs'), 'absent owners leave no own property');
  } else if (which === 'chain-kept') {
    const before = config.getConfig();
    assert.equal(before.snapshotPath, SNAP);
    assert.equal(before.serviceNowHost, HOST);
    assert.deepEqual(plain(before.githubOrgs), ORGS);
    config.saveConfig({ pollIntervalMs: 15000 });
    const after = config.getConfig();
    assert.equal(after.snapshotPath, SNAP, 'an unrelated write keeps the snapshot path');
    assert.equal(after.serviceNowHost, HOST, 'an unrelated write keeps the host');
    assert.deepEqual(plain(after.githubOrgs), ORGS, 'an unrelated write keeps the owners');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(onDisk.snapshotPath, SNAP, 'an unrelated write keeps the path on disk');
    assert.equal(onDisk.serviceNowHost, HOST);
    assert.deepEqual(onDisk.githubOrgs, ORGS);
  } else if (which === 'chain-clear-all') {
    const before = config.getConfig();
    assert.equal(before.snapshotPath, SNAP);
    assert.equal(before.serviceNowHost, HOST);
    assert.deepEqual(plain(before.githubOrgs), ORGS);
    config.saveConfig({ snapshotPath: null, serviceNowHost: null, githubOrgs: null });
    const after = config.getConfig();
    assert.ok(!Object.hasOwn(after, 'snapshotPath'), 'clearing leaves no snapshot property');
    assert.ok(!Object.hasOwn(after, 'serviceNowHost'), 'clearing leaves no host property');
    assert.ok(!Object.hasOwn(after, 'githubOrgs'), 'clearing leaves no owners property');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!Object.hasOwn(onDisk, 'snapshotPath'), 'clearing removes the path from the file');
    assert.ok(!Object.hasOwn(onDisk, 'serviceNowHost'), 'clearing removes the host from the file');
    assert.ok(!Object.hasOwn(onDisk, 'githubOrgs'), 'clearing removes the owners from the file');
  } else if (which === 'chain-orgs-empty') {
    config.saveConfig({ githubOrgs: [] });
    const after = config.getConfig();
    assert.deepEqual(plain(after.githubOrgs), [], 'empty list is stored');
    assert.ok(Object.hasOwn(after, 'githubOrgs'), 'empty list keeps the own property');
    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.deepEqual(onDisk.githubOrgs, [], 'the file records the empty list');
    config.saveConfig({ githubOrgs: null });
    const cleared = config.getConfig();
    assert.ok(!Object.hasOwn(cleared, 'githubOrgs'), 'null removes the owners with no own property left');
    const onDiskAfter = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!Object.hasOwn(onDiskAfter, 'githubOrgs'), 'null removes the owners from the file');
  } else if (which === 'chain-orgs-copy') {
    const patch = ['org-a'];
    config.saveConfig({ githubOrgs: patch });
    patch.push('evil');
    assert.deepEqual(plain(config.getConfig().githubOrgs), ['org-a'], 'the stored list is a copy');
  } else if (which === 'chain-invalid-save') {
    const beforeBytes = fs.readFileSync(cfgFile, 'utf8');
    const before = config.getConfig();
    assert.equal(before.snapshotPath, SNAP);
    assert.equal(before.pollIntervalMs, 30000);
    let caught = null;
    try {
      config.saveConfig({ pollIntervalMs: 15000, snapshotPath: '/other.json', serviceNowHost: 'https://example.com' });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'a mixed valid and invalid patch throws');
    assert.equal(caught.code, 'invalid_config', 'refusal carries code invalid_config');
    assert.ok(caught instanceof config.ConfigError, 'refusal is a ConfigError');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeBytes, 'the file is byte-for-byte unchanged');
    const after = config.getConfig();
    assert.equal(after.pollIntervalMs, 30000, 'poll interval is unchanged');
    assert.equal(after.snapshotPath, SNAP, 'snapshot path is unchanged');
  } else {
    throw new Error(`unknown child case ${which}`);
  }
  process.exit(0);
}

// Parent: pure half.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-work-'));
const isolatedGit = { GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' };
function runCase(name, { onDiskRaw, onDisk, mode, renameFail } = {}) {
  const xdg = fs.mkdtempSync(path.join(scratch, 'xdg-'));
  fs.mkdirSync(path.join(xdg, 'houston'), { recursive: true });
  if (onDiskRaw !== undefined) {
    fs.writeFileSync(path.join(xdg, 'houston', 'config.json'), onDiskRaw);
  } else if (onDisk !== undefined) {
    fs.writeFileSync(path.join(xdg, 'houston', 'config.json'), JSON.stringify(onDisk));
  }
  if (mode !== undefined) {
    fs.chmodSync(path.join(xdg, 'houston', 'config.json'), mode);
  }
  const work = fs.mkdtempSync(path.join(scratch, 'work-'));
  const childEnv = { ...process.env, ...isolatedGit, XDG_CONFIG_HOME: xdg, SCOTTY_WORK_CHILD: name };
  delete childEnv.BEADS_ACTOR;
  delete childEnv.BEADS_REPO;
  delete childEnv.SCOTTY_TEST_URL;
  if (renameFail) childEnv.SCOTTY_WORK_RENAME_FAIL = '1';
  else delete childEnv.SCOTTY_WORK_RENAME_FAIL;
  const res = spawnSync(process.execPath, [scriptPath], { cwd: work, env: childEnv, encoding: 'utf8' });
  assert.equal(res.status, 0, `${name} exited ${res.status}: stdout=${res.stdout} stderr=${res.stderr}`);
  assert.ok(!fs.existsSync(path.join(work, '.beads')), `${name} ran without a .beads folder`);
  return res;
}
function countWarning(stderr) {
  return stderr.split('[houston] config: workDashboardUrl ignored:').length - 1;
}
function countFor(stderr, key) {
  return stderr.split(`[houston] config: ${key} ignored:`).length - 1;
}

try {
  // Valid value is read, normalised.
  runCase('valid-read', { onDisk: { projects: [], workDashboardUrl: VALID_BARE } });

  // Invalid string, and separately falsy invalid values, warn exactly once across two reads.
  let res = runCase('invalid-string', { onDisk: { projects: [], workDashboardUrl: 'http://localhost/' } });
  assert.equal(countWarning(res.stderr), 1, 'invalid string warns exactly once');
  res = runCase('invalid-null', { onDisk: { projects: [], workDashboardUrl: null } });
  assert.equal(countWarning(res.stderr), 1, 'null warns exactly once');
  res = runCase('invalid-empty', { onDisk: { projects: [], workDashboardUrl: '' } });
  assert.equal(countWarning(res.stderr), 1, 'empty string warns exactly once');

  // Absent leaves no own property and no warning.
  res = runCase('absent', { onDisk: { projects: [] } });
  assert.equal(countWarning(res.stderr), 0, 'absent warns never');

  // A file holding null, [], or a string reads as empty without throwing.
  runCase('corrupt-null', { onDiskRaw: 'null' });
  runCase('corrupt-array', { onDiskRaw: '[]' });
  runCase('corrupt-string', { onDiskRaw: JSON.stringify('corrupt') });

  // A save over a corrupt file writes a plain object with no index keys.
  runCase('persist-corrupt-string', { onDiskRaw: JSON.stringify('corrupt') });
  runCase('persist-array', { onDiskRaw: JSON.stringify(['x']) });

  // 0644 becomes 0600 with no temp file left.
  runCase('mode-0600', { onDisk: { projects: [], pollIntervalMs: 30000 }, mode: 0o644 });

  // Hand-added keys survive an unrelated write; in-memory wins on conflict.
  runCase('merge-order', { onDisk: { projects: [], pollIntervalMs: 30000 } });

  // undefined in the patch is ignored.
  runCase('undefined-ignored', { onDisk: { projects: [], pollIntervalMs: 30000, workDashboardUrl: VALID } });

  // null removes the key.
  runCase('null-removes', { onDisk: { projects: [], pollIntervalMs: 30000, workDashboardUrl: VALID } });

  // Invalid save throws ConfigError and changes nothing.
  runCase('invalid-save', { onDisk: { projects: [], pollIntervalMs: 30000, workDashboardUrl: VALID } });

  // Rename failure keeps the old file, warns, leaves no temp, keeps memory.
  res = runCase('rename-fail', { onDisk: { projects: [], pollIntervalMs: 30000 } , renameFail: true });
  assert.ok(res.stderr.includes('[houston] config:'), 'rename failure warns with the config prefix');

  // Save normalises.
  runCase('save-normalises', { onDisk: { projects: [] } });

  // The three chain keys are read together.
  runCase('chain-valid-read', { onDisk: { projects: [], snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ORGS } });

  // An invalid value on disk is ignored whole with a warning, exactly once across two reads.
  res = runCase('chain-invalid-snapshot', { onDisk: { projects: [], snapshotPath: 'relative/path', serviceNowHost: HOST, githubOrgs: ORGS } });
  assert.equal(countFor(res.stderr, 'snapshotPath'), 1, 'invalid snapshot warns exactly once');
  res = runCase('chain-invalid-host', { onDisk: { projects: [], snapshotPath: SNAP, serviceNowHost: 'https://example.com', githubOrgs: ORGS } });
  assert.equal(countFor(res.stderr, 'serviceNowHost'), 1, 'invalid host warns exactly once');
  res = runCase('chain-invalid-orgs', { onDisk: { projects: [], snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ['Org-A'] } });
  assert.equal(countFor(res.stderr, 'githubOrgs'), 1, 'invalid owners warn exactly once');
  res = runCase('chain-invalid-orgs-list', { onDisk: { projects: [], snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: 'org-a' } });
  assert.equal(countFor(res.stderr, 'githubOrgs'), 1, 'non-list owners warn exactly once');

  // Absent chain keys leave no own property and warn nothing.
  res = runCase('chain-absent', { onDisk: { projects: [] } });
  assert.equal(countFor(res.stderr, 'snapshotPath'), 0, 'absent snapshot warns never');
  assert.equal(countFor(res.stderr, 'serviceNowHost'), 0, 'absent host warns never');
  assert.equal(countFor(res.stderr, 'githubOrgs'), 0, 'absent owners warn never');

  // The values survive an unrelated write.
  runCase('chain-kept', { onDisk: { projects: [], pollIntervalMs: 30000, snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ORGS } });

  // Clearing the three keys in one save leaves no own property.
  runCase('chain-clear-all', { onDisk: { projects: [], snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ORGS } });

  // An empty owners list is stored; null removes it.
  runCase('chain-orgs-empty', { onDisk: { projects: [] } });

  // The stored owners are a copy of the patch's list.
  runCase('chain-orgs-copy', { onDisk: { projects: [] } });

  // A patch mixing a valid and an invalid key writes nothing.
  runCase('chain-invalid-save', { onDisk: { projects: [], pollIntervalMs: 30000, snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ORGS } });

  console.log('PASS (unit): workDashboardUrl read, write, removal, atomic persist, merge order');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// Server half.
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
const json = { 'Content-Type': 'application/json' };
const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

{
  const initial = await call('GET', '/api/config');
  assert.equal(initial.status, 200);
  const initialPoll = initial.body.pollIntervalMs;
  try {
    let put = await call('PUT', '/api/config', { workDashboardUrl: VALID_BARE });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.workDashboardUrl, VALID, 'PUT answers the normalised url');
    let got = await call('GET', '/api/config');
    assert.equal(got.body.workDashboardUrl, VALID, 'GET returns the normalised url');

    put = await call('PUT', '/api/config', { pollIntervalMs: 15000 });
    assert.equal(put.status, 200);
    got = await call('GET', '/api/config');
    assert.equal(got.body.workDashboardUrl, VALID, 'an unrelated PUT keeps the url intact');
    assert.equal(got.body.pollIntervalMs, 15000);

    put = await call('PUT', '/api/config', { workDashboardUrl: 'http://localhost:8000/' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.workDashboardUrl, VALID, 'a refused host leaves the value unchanged');

    put = await call('PUT', '/api/config', { workDashboardUrl: '   ' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.workDashboardUrl, VALID, 'a blank url leaves the value unchanged');

    put = await call('PUT', '/api/config', { workDashboardUrl: '' });
    assert.equal(put.status, 200);
    got = await call('GET', '/api/config');
    assert.ok(!Object.hasOwn(got.body, 'workDashboardUrl'), 'empty string removes the key');

    put = await call('PUT', '/api/config', { workDashboardUrl: VALID_BARE });
    assert.equal(put.status, 200);
    assert.equal(put.body.workDashboardUrl, VALID);
    put = await call('PUT', '/api/config', { workDashboardUrl: null });
    assert.equal(put.status, 200);
    got = await call('GET', '/api/config');
    assert.ok(!Object.hasOwn(got.body, 'workDashboardUrl'), 'null removes the key');
  } finally {
    await call('PUT', '/api/config', { workDashboardUrl: null });
    await call('PUT', '/api/config', { pollIntervalMs: initialPoll });
  }
}

{
  const cap = async (cookie) => {
    const res = await fetch(`${base}/api/capabilities`, { headers: cookie ? { Cookie: cookie } : undefined });
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') ?? '' };
  };
  try {
    await call('PUT', '/api/config', { workDashboardUrl: null, snapshotPath: null, serviceNowHost: null, githubOrgs: null });
    let got = await cap();
    assert.equal(got.status, 200);
    assert.ok(got.cache.includes('no-store'), `capabilities answers no-store, got ${got.cache}`);
    assert.deepEqual(got.body, { workDashboardUrl: null, chain: false }, 'capabilities is null before the key is set');

    const put = await call('PUT', '/api/config', { workDashboardUrl: VALID_BARE });
    assert.equal(put.status, 200);
    got = await cap();
    assert.equal(got.status, 200);
    assert.ok(got.cache.includes('no-store'), `capabilities answers no-store, got ${got.cache}`);
    assert.deepEqual(got.body, { workDashboardUrl: VALID, chain: false }, 'capabilities carries the normalised url after set');

    got = await cap('scotty-viewer-mode=read-only');
    assert.equal(got.status, 200, 'capabilities stays 200 in viewer mode');
    assert.ok(got.cache.includes('no-store'), `capabilities answers no-store in viewer mode, got ${got.cache}`);
    assert.deepEqual(got.body, { workDashboardUrl: VALID, chain: false }, 'capabilities keeps the url in viewer mode');

    const cleared = await call('PUT', '/api/config', { workDashboardUrl: '' });
    assert.equal(cleared.status, 200);
    got = await cap();
    assert.equal(got.status, 200);
    assert.ok(got.cache.includes('no-store'), `capabilities answers no-store, got ${got.cache}`);
    assert.deepEqual(got.body, { workDashboardUrl: null, chain: false }, 'capabilities is null again after clearing with ""');
  } finally {
    await call('PUT', '/api/config', { workDashboardUrl: null });
  }
}

{
  const initial = await call('GET', '/api/config');
  assert.equal(initial.status, 200);
  try {
    await call('PUT', '/api/config', { snapshotPath: null, serviceNowHost: null, githubOrgs: null });

    let put = await call('PUT', '/api/config', { snapshotPath: SNAP });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.snapshotPath, SNAP, 'PUT answers the snapshot path');
    let got = await call('GET', '/api/config');
    assert.equal(got.body.snapshotPath, SNAP, 'GET returns the snapshot path');

    put = await call('PUT', '/api/config', { serviceNowHost: HOST });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.serviceNowHost, HOST, 'PUT answers the host');
    got = await call('GET', '/api/config');
    assert.equal(got.body.serviceNowHost, HOST, 'GET returns the host');
    assert.equal(got.body.snapshotPath, SNAP, 'setting the host keeps the path intact');

    put = await call('PUT', '/api/config', { githubOrgs: ORGS });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.githubOrgs, ORGS, 'PUT answers the owners');
    got = await call('GET', '/api/config');
    assert.deepEqual(got.body.githubOrgs, ORGS, 'GET returns the owners');

    put = await call('PUT', '/api/config', { githubOrgs: [] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.githubOrgs, [], 'an empty list is stored');
    got = await call('GET', '/api/config');
    assert.deepEqual(got.body.githubOrgs, [], 'GET returns the empty list');
    put = await call('PUT', '/api/config', { githubOrgs: ORGS });
    assert.equal(put.status, 200);

    put = await call('PUT', '/api/config', { serviceNowHost: 'https://example.com' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.serviceNowHost, HOST, 'a refused host leaves the value unchanged');

    put = await call('PUT', '/api/config', { snapshotPath: 'relative/path' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.snapshotPath, SNAP, 'a relative path leaves the value unchanged');

    put = await call('PUT', '/api/config', { snapshotPath: '   ' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.snapshotPath, SNAP, 'a blank path leaves the value unchanged');

    put = await call('PUT', '/api/config', { githubOrgs: ['Org-A'] });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.deepEqual(got.body.githubOrgs, ORGS, 'refused owners leave the value unchanged');

    put = await call('PUT', '/api/config', { snapshotPath: '/other.json', serviceNowHost: 'https://example.com' });
    assert.equal(put.status, 400);
    assert.equal(put.body.code, 'invalid_config');
    got = await call('GET', '/api/config');
    assert.equal(got.body.snapshotPath, SNAP, 'a mixed valid and invalid patch writes nothing');
    assert.equal(got.body.serviceNowHost, HOST, 'a mixed valid and invalid patch writes nothing');

    put = await call('PUT', '/api/config', { snapshotPath: '', serviceNowHost: '', githubOrgs: null });
    assert.equal(put.status, 200);
    got = await call('GET', '/api/config');
    assert.ok(!Object.hasOwn(got.body, 'snapshotPath'), 'empty string removes the path');
    assert.ok(!Object.hasOwn(got.body, 'serviceNowHost'), 'empty string removes the host');
    assert.ok(!Object.hasOwn(got.body, 'githubOrgs'), 'null removes the owners');

    put = await call('PUT', '/api/config', { snapshotPath: SNAP, serviceNowHost: HOST, githubOrgs: ORGS });
    assert.equal(put.status, 200);
    put = await call('PUT', '/api/config', { snapshotPath: null, serviceNowHost: null, githubOrgs: null });
    assert.equal(put.status, 200);
    got = await call('GET', '/api/config');
    assert.ok(!Object.hasOwn(got.body, 'snapshotPath'), 'null removes the path');
    assert.ok(!Object.hasOwn(got.body, 'serviceNowHost'), 'null removes the host');
    assert.ok(!Object.hasOwn(got.body, 'githubOrgs'), 'null removes the owners');
  } finally {
    await call('PUT', '/api/config', { snapshotPath: null, serviceNowHost: null, githubOrgs: null });
  }
}

{
  const cap = async () => {
    const res = await fetch(`${base}/api/capabilities`);
    return { status: res.status, body: await res.json() };
  };
  try {
    await call('PUT', '/api/config', { snapshotPath: null });
    let got = await cap();
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { workDashboardUrl: null, chain: false }, 'chain is false without a snapshot path');

    const put = await call('PUT', '/api/config', { snapshotPath: SNAP });
    assert.equal(put.status, 200);
    got = await cap();
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { workDashboardUrl: null, chain: true }, 'chain is true once the path is set');

    await call('PUT', '/api/config', { snapshotPath: '' });
    got = await cap();
    assert.deepEqual(got.body, { workDashboardUrl: null, chain: false }, 'chain is false again after clearing');
  } finally {
    await call('PUT', '/api/config', { snapshotPath: null, serviceNowHost: null, githubOrgs: null });
  }
}
console.log('PASS (server): config route accepts, refuses and clears workDashboardUrl; capabilities answers the one field with no-store');
