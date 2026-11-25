// Loads lib/config.ts in child processes with throwaway config dirs, git config
// and launch directories. Never touches the real ~/.config or git settings.
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

// Child entry: re-executes this script with SCOTTY_ACTOR_CHILD set. Runs first,
// before any parent setup, so the child neither repeats git init nor leaks it.
if (process.env.SCOTTY_ACTOR_CHILD) {
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
  if (process.env.SCOTTY_ACTOR_SAVE) {
    config.saveConfig(JSON.parse(process.env.SCOTTY_ACTOR_SAVE));
  }
  const c = config.getConfig();
  console.log(JSON.stringify({ humanActor: c.humanActor, humanAllowlist: plain(c.humanAllowlist), humanActorChosen: c.humanActorChosen }));
  process.exit(0);
}

const osUser = os.userInfo().username;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-actor-'));
const gitRepo = path.join(scratch, 'repo');
const noGit = path.join(scratch, 'plain');
fs.mkdirSync(gitRepo);
fs.mkdirSync(noGit);
const isolatedGit = { GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['init', '-q'], { cwd: gitRepo, env: { ...process.env, ...isolatedGit } });
execFileSync('git', ['config', 'user.name', 'Scotty Test Actor'], { cwd: gitRepo, env: { ...process.env, ...isolatedGit } });

let n = 0;
/** Run getConfig() (and optionally saveConfig) in a fresh process. */
function load({ cwd = gitRepo, env = {}, onDisk, save } = {}) {
  const xdg = path.join(scratch, `xdg-${n++}`);
  fs.mkdirSync(path.join(xdg, 'houston'), { recursive: true });
  if (onDisk) fs.writeFileSync(path.join(xdg, 'houston', 'config.json'), JSON.stringify(onDisk));
  const childEnv = { ...process.env, ...isolatedGit, XDG_CONFIG_HOME: xdg, ...env };
  if (!('BEADS_ACTOR' in env)) delete childEnv.BEADS_ACTOR;
  delete childEnv.BEADS_REPO;
  childEnv.SCOTTY_ACTOR_CHILD = '1';
  if (save) childEnv.SCOTTY_ACTOR_SAVE = JSON.stringify(save);
  else delete childEnv.SCOTTY_ACTOR_SAVE;
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd, env: childEnv, encoding: 'utf8' });
  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`);
  return { ...JSON.parse(res.stdout.trim().split('\n').pop()), xdg };
}

try {
  // Fresh install: follow bd's order.
  let c = load();
  assert.equal(c.humanActor, 'Scotty Test Actor', 'git user.name comes before the OS user');
  assert.deepEqual(c.humanAllowlist, ['Scotty Test Actor']);
  assert.equal(load({ env: { BEADS_ACTOR: 'env-actor' } }).humanActor, 'env-actor', 'BEADS_ACTOR wins');
  assert.equal(load({ cwd: noGit }).humanActor, osUser, 'without a git name, the OS user');

  // Upgrade: the old computed default on disk is replaced, keeping the allowlist.
  c = load({ onDisk: { humanActor: osUser, humanAllowlist: [osUser, 'pal'], projects: [] } });
  assert.equal(c.humanActor, 'Scotty Test Actor', 'stale OS-user default is replaced');
  assert.deepEqual(c.humanAllowlist, [osUser, 'pal', 'Scotty Test Actor'], 'new actor joins the allowlist');
  c = load({ cwd: noGit, onDisk: { humanActor: osUser, humanAllowlist: [osUser], projects: [] } });
  assert.equal(c.humanActor, osUser, 'no git name: nothing changes');
  assert.deepEqual(c.humanAllowlist, [osUser]);

  // Explicit choices stick.
  c = load({ onDisk: { humanActor: osUser, humanAllowlist: [osUser], humanActorChosen: true, projects: [] } });
  assert.equal(c.humanActor, osUser, 'an actor saved from Settings is kept');
  assert.equal(load({ onDisk: { humanActor: 'Someone Else', humanAllowlist: ['Someone Else'], projects: [] } }).humanActor, 'Someone Else', 'a non-default name is kept');
  c = load({ save: { humanActor: osUser } });
  assert.equal(c.humanActorChosen, true);
  const saved = JSON.parse(fs.readFileSync(path.join(c.xdg, 'houston', 'config.json'), 'utf8'));
  assert.equal(saved.humanActor, osUser);
  assert.equal(saved.humanActorChosen, true, 'saving from Settings records the choice');
  assert.equal(load({ onDisk: saved }).humanActor, osUser, 'the saved choice survives a restart');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("PASS actor default: BEADS_ACTOR > git user.name > OS user; stale defaults upgraded; Settings choices kept");
