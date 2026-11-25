// Pure unit tests for lib/config-values.ts, without a build or a server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
  const req = (id) => (id.startsWith('./') ? load(id.slice(2)) : require(id));
  vm.runInNewContext(code, { exports, require: req, structuredClone, Date, process, console, URL }, { filename: name });
  return (loaded[name] = exports);
}

const {
  checkSnapshotPath,
  checkServiceNowHost,
  checkGithubOrg,
  checkGithubOrgs,
  checkPipelineRepo,
  checkTicketNumber,
} = load('config-values');

function accepts(result, expectedValue, label) {
  assert.equal(result.ok, true, `${label} is accepted`);
  assert.deepEqual(result.value, expectedValue, `${label} round-trips`);
}

function refuses(result, label) {
  assert.equal(result.ok, false, `${label} is refused`);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, `${label} carries a reason`);
}

// snapshotPath: accepted.
accepts(checkSnapshotPath('/snapshots/chain.json'), '/snapshots/chain.json', 'absolute snapshot path');

// snapshotPath: refused per rule.
refuses(checkSnapshotPath('snapshots/chain.json'), 'relative snapshot path');
refuses(checkSnapshotPath(' /snapshots/chain.json '), 'snapshot path with surrounding spaces');
refuses(checkSnapshotPath('/snap\0.json'), 'snapshot path containing a NUL');

// serviceNowHost: accepted, including one-character labels.
accepts(checkServiceNowHost('example.com'), 'example.com', 'bare host');
accepts(checkServiceNowHost('a.co'), 'a.co', 'one-character labels');

// serviceNowHost: refused per rule.
refuses(checkServiceNowHost('https://example.com'), 'host with scheme');
refuses(checkServiceNowHost('example.com:443'), 'host with port');
refuses(checkServiceNowHost('Example.com'), 'uppercase host');
refuses(checkServiceNowHost('user@example.com'), 'host with user information');
refuses(checkServiceNowHost('.example.com'), 'host with leading dot');
refuses(checkServiceNowHost('a..b'), 'host with empty label');
refuses(checkServiceNowHost('-bad.com'), 'host with leading hyphen');
refuses(checkServiceNowHost('bad-.com'), 'host with trailing hyphen');
refuses(checkServiceNowHost('localhost'), 'single-label host');
refuses(checkServiceNowHost('127.0.0.1'), 'IPv4 literal');

// githubOrgs: accepted, including a one-character owner and an empty list.
accepts(checkGithubOrg('a'), 'a', 'one-character owner');
accepts(checkGithubOrgs(['a']), ['a'], 'single owner list');
{
  const result = checkGithubOrgs([]);
  assert.equal(result.ok, true, 'empty list is accepted');
  assert.deepEqual(result.value, [], 'empty list round-trips');
}
{
  const result = checkGithubOrgs(['org-a', 'a']);
  assert.equal(result.ok, true, 'owner list is accepted');
  assert.deepEqual(result.value, ['org-a', 'a'], 'owner list round-trips');
}
// The stored list is a copy of the patch's list.
{
  const patch = ['org-a'];
  const result = checkGithubOrgs(patch);
  assert.equal(result.ok, true, 'copy check is accepted');
  patch.push('evil');
  assert.deepEqual(result.value, ['org-a'], 'stored list is a copy');
}

// githubOrgs: refused per rule, whole rather than filtered.
refuses(checkGithubOrgs(['Org-A']), 'uppercase owner in the list');
refuses(checkGithubOrgs(['-org']), 'leading-hyphen owner in the list');
refuses(checkGithubOrgs(['org-']), 'trailing-hyphen owner in the list');
refuses(checkGithubOrgs('org-a'), 'non-list githubOrgs');
refuses(checkGithubOrgs(['org-a', 'Bad!']), 'list with one invalid entry');

// pipelineRepo: accepted.
accepts(checkPipelineRepo('org/repo-a'), 'org/repo-a', 'pipeline repository');
accepts(checkPipelineRepo('a/b'), 'a/b', 'one-character pipeline repository');

// pipelineRepo: refused per rule.
refuses(checkPipelineRepo('org/..'), 'repository parent reference');
refuses(checkPipelineRepo('org/.'), 'repository self reference');
refuses(checkPipelineRepo('Org/repo-a'), 'uppercase repository owner');
refuses(checkPipelineRepo('org/Repo-A'), 'uppercase repository name');

// ticket-number shape: accepted.
accepts(checkTicketNumber('CHG00000001'), 'CHG00000001', 'change number');
accepts(checkTicketNumber('A1'), 'A1', 'minimal ticket number');

// ticket-number shape: refused per rule.
refuses(checkTicketNumber('chg1'), 'lowercase ticket prefix');
refuses(checkTicketNumber('CHG'), 'ticket prefix without digits');
refuses(checkTicketNumber('1'), 'ticket digits without prefix');
refuses(checkTicketNumber('CHG1?x=1'), 'ticket number with extra characters');
refuses(checkTicketNumber('ABCDEFGHIJKLM1'), '13-letter ticket prefix');
refuses(checkTicketNumber(`A${'0'.repeat(21)}`), '21-digit ticket suffix');

console.log('PASS (unit): config value validators accept and refuse every rule');
