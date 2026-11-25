// The format-v1 snapshot reader. Pure, no build and no server: lib/snapshot-format.ts loads
// through a transpile-then-vm loader and runs over scripts/fixtures/snapshot-v1.json and copies of
// it edited case by case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const fixtureText = fs.readFileSync(new URL('./fixtures/snapshot-v1.json', import.meta.url), 'utf8');

// esModuleInterop, because without it `import fs from "node:fs"` compiles to an undefined
// `node_fs_1.default`.
function makeLoader(external) {
  const moduleCache = new Map();
  function load(name) {
    if (moduleCache.has(name)) return moduleCache.get(name);
    const exports = {};
    moduleCache.set(name, exports);
    const source = fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, { filename: `lib/${name}.ts` });
    wrapper(exports, (id) => (id.startsWith('./') ? load(id.slice(2)) : external(id)));
    return exports;
  }
  return load;
}

pureCases();
console.log('test-snapshot: ok');

// ------------------------------------------------------------------ pure: lib/snapshot-format.ts

function pureCases() {
  const format = makeLoader((id) => require(id))('snapshot-format');
  const TICKETS = [
    'incidents',
    'changes',
    'work_tracker_stories',
    'work_tracker_bugs',
    'work_tracker_tasks',
    'work_tracker_subtasks',
    'ritms',
  ];
  const base = () => JSON.parse(fixtureText);
  const read = (doc) => {
    const result = format.readSnapshotDocument(doc);
    assert.equal(result.ok, true, `the document reads: ${result.reason}`);
    return result.snapshot;
  };
  const variant = (edit) => {
    const doc = base();
    edit(doc.sources, doc);
    return read(doc);
  };
  const lookup = format.lookupTicket;
  const snapshot = read(base());
  const fallback = (key) => ({
    label: key,
    provider: null,
    status: 'error',
    complete: false,
    last_attempt_at: null,
    last_success_at: null,
    error: 'invalid envelope',
  });
  const notCollected = (key) => ({ ...fallback(key), status: 'not_collected', error: null });
  const ticketSource = (snap, key) => snap.tickets[key];
  // One more record of any shape appended to a source's records.
  const withRecord = (source, record) => variant((s) => s[source].records.push(record));
  const validRecord = (number) => ({
    key: `key-${number}`,
    number,
    title: 'Synthetic record',
    state: 'Open',
    link: 'https://example.com/record.do?sys_id=00000000000000000000000000000099',
  });

  // The fixture as a whole.
  {
    const parsed = format.parseSnapshot(fixtureText);
    assert.equal(parsed.ok, true, 'the fixture parses from its text');
    for (const key of TICKETS) {
      const source = ticketSource(snapshot, key);
      assert.equal(source.dropped, 0, `fixture: no ${key} record is dropped`);
      assert.equal(source.effectiveStatus, 'ok', `fixture: ${key} is ok`);
    }
    assert.equal(ticketSource(snapshot, 'work_tracker_stories').records[0].sprint, 'sprint-a', 'a story keeps its sprint');
    assert.equal(snapshot.approvals.records.length, 3, 'fixture: every approval reads');
  }

  // Freshness, one value from each of three envelopes of the fixture.
  assert.deepEqual(ticketSource(snapshot, 'incidents').freshness, { state: 'confirmed' }, 'freshness confirmed: ok and complete');
  assert.deepEqual(
    snapshot.approvals.freshness,
    { state: 'historical', at: '2026-11-19T12:00:30.123456+00:00' },
    'freshness historical: a failed source with a last_success_at carrying fractional seconds',
  );
  assert.deepEqual(snapshot.pipeline.freshness, { state: 'partial' }, 'freshness partial: no last_success_at');

  // Found.
  {
    const answer = lookup(snapshot, 'inc00000001');
    assert.equal(answer.result, 'found', 'found: a lowercase identifier finds an uppercase number');
    assert.equal(answer.source, 'incidents', 'found: the source is named');
    assert.equal(answer.record.number, 'INC00000001', 'found: the record is returned');
    assert.deepEqual(answer.freshness, { state: 'confirmed' }, 'found: with its source freshness');
    assert.deepEqual(answer.approvals, [], 'found: no approval of another number');
    assert.equal(lookup(snapshot, 'Stry00000001').source, 'work_tracker_stories', 'found in a later source');
    assert.equal(lookup(snapshot, 'RITM00000001').source, 'ritms', 'found in the last source');
    assert.equal(lookup(snapshot, '  INC00000001\t').result, 'found', 'the identifier is trimmed');
    const padded = withRecord('work_tracker_bugs', validRecord(' BUG00000002 '));
    assert.equal(lookup(padded, 'bug00000002').result, 'found', "a record's number is trimmed");
    const failed = variant((s) => Object.assign(s.incidents, { status: 'error', complete: false }));
    assert.deepEqual(
      lookup(failed, 'INC00000001').freshness,
      { state: 'historical', at: '2026-11-20T12:00:30+00:00' },
      'found in a failed source carries its historical freshness',
    );
    const both = withRecord('ritms', validRecord('INC00000001'));
    assert.equal(lookup(both, 'INC00000001').source, 'incidents', 'the first source in the fixed order wins');
  }

  // Absent.
  {
    const answer = lookup(snapshot, 'STRY00000099');
    assert.equal(answer.result, 'absent', 'absent: every ticket source ok and complete');
    assert.deepEqual(answer.approvals, [], 'absent: no approval');
    assert.equal(lookup(snapshot, '201').result, 'absent', 'a pipeline record is not a ticket');
    const other = variant((s) => {
      s.other_tickets = { ...s.incidents, label: 'Other', records: [validRecord('INC00000077')] };
    });
    assert.equal(lookup(other, 'INC00000077').result, 'absent', 'a source this phase does not read is never searched');
  }

  // Unconfirmed: any single ticket source partial, not collected, or malformed.
  for (const key of TICKETS) {
    const partial = variant((s) => Object.assign(s[key], { status: 'partial', complete: false }));
    const answer = lookup(partial, 'STRY00000099');
    assert.equal(answer.result, 'unconfirmed', `unconfirmed because ${key} is partial`);
    assert.deepEqual(answer.incompleteSources, [key], `unconfirmed names ${key}`);

    const missing = variant((s) => delete s[key]);
    assert.deepEqual(ticketSource(missing, key).envelope, notCollected(key), `${key} absent from the file is not_collected`);
    assert.deepEqual(ticketSource(missing, key).records, [], `${key} absent from the file has no records`);
    assert.equal(lookup(missing, 'STRY00000099').result, 'unconfirmed', `unconfirmed because ${key} is missing`);
  }
  for (const [label, value] of [
    ['null', null],
    ['an array', []],
    ['missing fields', { label: 'Changes', status: 'ok', complete: true, records: [] }],
    ['a status outside the closed set', { ...base().sources.changes, status: 'done' }],
    ['records not a list', { ...base().sources.changes, records: {} }],
  ]) {
    const snap = variant((s) => {
      s.changes = value;
    });
    assert.deepEqual(ticketSource(snap, 'changes').envelope, fallback('changes'), `an envelope with ${label} becomes the fallback`);
    assert.equal(lookup(snap, 'CHG00000001').result, 'unconfirmed', `a lookup beside an envelope with ${label} is unconfirmed`);
  }

  // A record dropped by validation makes its source partial even with last_success_at set.
  {
    const failed = { status: 'error', complete: false, error: 'Source consultation failed.' };
    const kept = variant((s) => Object.assign(s.changes, failed));
    assert.deepEqual(
      ticketSource(kept, 'changes').freshness,
      { state: 'historical', at: '2026-11-20T12:00:30+00:00' },
      'control: a failed source whose records all read is historical',
    );
    const dropped = variant((s) => {
      Object.assign(s.changes, failed);
      s.changes.records.push({ key: 'bad', number: 5 });
    });
    assert.equal(ticketSource(dropped, 'changes').dropped, 1, 'the invalid record is counted');
    assert.equal(ticketSource(dropped, 'changes').records.length, 1, 'the valid record is kept');
    assert.deepEqual(ticketSource(dropped, 'changes').freshness, { state: 'partial' }, 'a dropped record makes a source partial despite last_success_at');
    assert.equal(ticketSource(dropped, 'changes').effectiveStatus, 'error', 'a dropped record leaves a failed status as it is');
  }

  // A record dropped from a source that says ok and complete.
  {
    const snap = withRecord('changes', { ...validRecord('CHG00000009'), number: null });
    const source = ticketSource(snap, 'changes');
    assert.equal(source.dropped, 1, 'ok source: the invalid record is counted');
    assert.equal(source.effectiveStatus, 'partial', 'ok source with a dropped record has the effective status partial');
    assert.equal(source.effectiveComplete, false, 'ok source with a dropped record is not complete');
    assert.deepEqual(source.freshness, { state: 'partial' }, 'ok source with a dropped record is partial, not confirmed');
    const answer = lookup(snap, 'STRY00000099');
    assert.equal(answer.result, 'unconfirmed', 'a miss is unconfirmed when an ok and complete source dropped a record');
    assert.deepEqual(answer.incompleteSources, ['changes'], 'the source that dropped a record is named');
  }

  // ok with complete: false.
  {
    const snap = variant((s) => {
      s.changes.complete = false;
    });
    assert.equal(ticketSource(snap, 'changes').effectiveStatus, 'partial', 'ok with complete false has the effective status partial');
    assert.deepEqual(
      ticketSource(snap, 'changes').freshness,
      { state: 'historical', at: '2026-11-20T12:00:30+00:00' },
      'ok with complete false is historical, not confirmed',
    );
    assert.equal(lookup(snap, 'STRY00000099').result, 'unconfirmed', 'a miss is unconfirmed beside an ok but incomplete source');
  }

  // last_success_at: what counts as a date-time.
  {
    const freshnessWith = (value) =>
      ticketSource(
        variant((s) => Object.assign(s.changes, { status: 'error', complete: false, last_success_at: value })),
        'changes',
      ).freshness;
    for (const value of [
      '2026-11-20T12:00:00Z',
      '2026-11-20T12:00:00-03:00',
      '2026-11-20T12:00:00.5Z',
      '2026-11-20T12:00:30.123456+00:00',
      '2024-02-29T00:00:00+00:00',
      '2026-11-20T23:59:59+23:59',
    ]) {
      assert.deepEqual(freshnessWith(value), { state: 'historical', at: value }, `last_success_at ${value} is historical`);
    }
    for (const value of [
      '1',
      'yesterday',
      '',
      '2026-02-31T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-11-20T12:00:00+24:00',
      '2026-11-20T12:00:00+03:60',
      '2026-11-20T24:00:00Z',
      '2026-11-20T12:00:00',
      '2026-11-20 12:00:00Z',
      '2026-11-20T12:00Z',
      '2026-11-20T12:00:00.Z',
    ]) {
      assert.deepEqual(freshnessWith(value), { state: 'partial' }, `last_success_at ${JSON.stringify(value)} is not historical`);
    }
    assert.equal(format.isIsoDateTime('0099-01-01T00:00:00Z'), false, 'a year Date.UTC moves into the 1900s does not read back');
  }

  // Sources a ticket lookup never depends on.
  {
    const withoutUnread = variant((s) => delete s.observability_logs);
    assert.deepEqual(snapshot, withoutUnread, 'a malformed envelope in a source this phase does not read changes nothing');
    const brokenPipeline = variant((s) => {
      s.pipeline = { status: 'bogus' };
    });
    assert.deepEqual(brokenPipeline.pipeline.envelope, fallback('pipeline'), 'a malformed pipeline envelope becomes the fallback');
    for (const id of ['INC00000001', 'STRY00000099', 'CHG00000002']) {
      assert.deepEqual(lookup(brokenPipeline, id), lookup(snapshot, id), `a malformed pipeline envelope does not change the lookup of ${id}`);
    }
    const brokenApprovals = variant((s) => {
      s.approvals = 'oops';
    });
    assert.equal(lookup(brokenApprovals, 'CHG00000002').result, 'absent', 'a malformed approvals envelope does not make a miss unconfirmed');
    assert.deepEqual(lookup(brokenApprovals, 'CHG00000002').approvals, [], 'a malformed approvals envelope returns no approval');
  }

  // Approvals, returned with every answer and never the primary record.
  {
    const historical = { state: 'historical', at: '2026-11-19T12:00:30.123456+00:00' };
    const found = lookup(snapshot, 'CHG00000001');
    assert.equal(found.result, 'found', 'a change with an approval is found');
    assert.equal(found.source, 'changes', 'found in changes, not in approvals');
    assert.equal(found.approvals.length, 1, 'found: its approval comes with it');
    assert.equal(found.approvals[0].record.key, '00000000000000000000000000000011', "the approval keeps its own key");
    assert.equal(found.approvals[0].record.record_type, 'change_request', "the approval names the ticket's class");
    assert.match(found.approvals[0].record.link, /sysapproval_approver/, "the approval keeps its own link");
    assert.deepEqual(found.approvals[0].freshness, historical, "an approval carries the approvals source's freshness");

    const absent = lookup(snapshot, 'chg00000002');
    assert.equal(absent.result, 'absent', 'an approval alone never makes an answer found');
    assert.deepEqual(
      absent.approvals.map((match) => match.record.key),
      ['00000000000000000000000000000012'],
      'absent: the approval of a change outside the collected scope, found by a lowercase identifier',
    );

    const partial = variant((s) => Object.assign(s.changes, { status: 'partial', complete: false }));
    const unconfirmed = lookup(partial, 'CHG00000002');
    assert.equal(unconfirmed.result, 'unconfirmed', 'unconfirmed beside a partial changes source');
    assert.deepEqual(
      unconfirmed.approvals.map((match) => match.record.key),
      ['00000000000000000000000000000012'],
      'unconfirmed: the approval comes with it',
    );

    const confirmedApprovals = variant((s) => Object.assign(s.approvals, { status: 'ok', complete: true }));
    assert.deepEqual(lookup(confirmedApprovals, 'CHG00000002').approvals[0].freshness, { state: 'confirmed' }, 'approvals freshness follows its own envelope');
    const paddedApproval = variant((s) => {
      s.approvals.records[1].number = ' CHG00000002 ';
    });
    assert.equal(lookup(paddedApproval, 'CHG00000002').approvals.length, 1, "an approval's number is trimmed");
  }

  // An empty identifier finds nothing, even beside a record and an approval whose number is "".
  for (const empty of ['', '   ']) {
    const answer = lookup(snapshot, empty);
    assert.equal(answer.result, 'absent', `the identifier ${JSON.stringify(empty)} finds no ticket`);
    assert.deepEqual(answer.approvals, [], `the identifier ${JSON.stringify(empty)} finds no approval`);
  }

  // Pipeline records.
  {
    const records = snapshot.pipeline.records;
    assert.equal(snapshot.pipeline.dropped, 0, 'pipeline: no fixture record is dropped');
    assert.equal(records.length, 6, 'pipeline: every fixture record reads');
    const byKey = (key) => records.find((record) => record.key === key);
    const waiting = byKey('run:org/repo-a:101');
    assert.equal(waiting.kind, 'run', 'a waiting run parses');
    assert.equal(waiting.conclusion, null, 'a waiting run has no conclusion');
    assert.deepEqual(waiting.changes, ['CHG00000001'], 'a run keeps its changes');
    assert.deepEqual(waiting.existing_prs, [201], 'a run keeps its existing pull requests');
    assert.equal(byKey('run:org/repo-b:102').head, null, 'a run with no head parses');
    assert.deepEqual(byKey('pr:org/repo-a:201').anomalies, ['stale_release'], 'a pull request parses');
    const repoIssue = byKey('issue:org/repo-b:pulls');
    assert.equal(repoIssue.run_id, null, 'a repository-level issue parses with run_id null');
    assert.equal(repoIssue.repo, 'org/repo-b', 'a repository-level issue keeps its repo');
    assert.equal(byKey('issue:org/repo-a:annotations:101').run_id, 101, 'a run-level issue parses with its run_id');
    const budget = byKey('issue:budget');
    assert.equal(budget.limit, 120, 'the budget issue parses with its limit');
    assert.ok(!('repo' in budget) && !('run_id' in budget), 'the budget issue has no repo and no run_id');
  }
  {
    const issue = (extra) => ({ key: 'issue:x', kind: 'issue', repo: 'org/repo-a', part: 'recent', error: 'Failed.', ...extra });
    const run = (extra) => ({
      key: 'run:x',
      kind: 'run',
      repo: 'org/repo-a',
      id: 103,
      created_at: '2026-11-20T08:00:00Z',
      status: 'completed',
      conclusion: 'failure',
      head: 'main',
      ...extra,
    });
    const accepted = (label, record) =>
      assert.equal(withRecord('pipeline', record).pipeline.dropped, 0, `pipeline accepts ${label}`);
    const dropped = (label, record) => {
      const snap = withRecord('pipeline', record);
      assert.equal(snap.pipeline.dropped, 1, `pipeline drops ${label}`);
      assert.equal(snap.pipeline.records.length, 6, `pipeline keeps the others beside ${label}`);
    };
    accepted('a repository issue with no run_id', issue({}));
    accepted('a run id of 2**53 - 1', run({ id: Number.MAX_SAFE_INTEGER }));
    dropped('a repository issue without repo', issue({ repo: undefined, part: 'annotations', run_id: 101 }));
    dropped('a repository issue without error', issue({ error: undefined }));
    dropped('a repository issue with a limit', issue({ limit: 120 }));
    dropped('an issue with an empty part', issue({ part: '' }));
    dropped('a budget part with a repo and no limit', issue({ part: 'budget' }));
    dropped('a budget issue with a repo', { key: 'issue:budget', kind: 'issue', part: 'budget', limit: 120, repo: 'org/repo-a' });
    dropped('a budget issue with a run_id', { key: 'issue:budget', kind: 'issue', part: 'budget', limit: 120, run_id: null });
    dropped('a budget issue without a limit', { key: 'issue:budget', kind: 'issue', part: 'budget' });
    dropped('a run_id that is not an integer', issue({ run_id: 1.5 }));
    dropped('a run id of 2**53', run({ id: 2 ** 53 }));
    dropped('a run id of 0', run({ id: 0 }));
    dropped('a run id as a string', run({ id: '103' }));
    dropped('a run without conclusion', run({ conclusion: undefined }));
    dropped('an existing pull request of 0', run({ existing_prs: [0] }));
    dropped('a change that is not a string', run({ changes: [7] }));
    dropped('a pull request number of 2**53', {
      key: 'pr:x',
      kind: 'pr',
      repo: 'org/repo-a',
      number: 2 ** 53,
      base: 'main',
      head: 'release/example-a',
      anomalies: [],
    });
    dropped('an unknown kind', { key: 'deploy:x', kind: 'deploy', repo: 'org/repo-a' });
  }

  // Ticket and approval records.
  {
    const noTitle = { ...validRecord('INC00000002'), title: undefined };
    assert.equal(withRecord('incidents', noTitle).tickets.incidents.dropped, 1, 'a ticket record without a title is dropped');
    assert.equal(withRecord('work_tracker_stories', { ...validRecord('STRY00000002'), sprint: 7 }).tickets.work_tracker_stories.dropped, 1, 'a story with a sprint that is not a string is dropped');
    assert.equal(withRecord('ritms', validRecord('')).tickets.ritms.dropped, 0, 'a request item whose number is "" is kept');
    assert.equal(withRecord('approvals', validRecord('CHG00000003')).approvals.dropped, 1, 'an approval without record_type is dropped');
  }

  // Unreadable files.
  {
    const unreadable = (label, doc) => {
      const result = format.readSnapshotDocument(doc);
      assert.equal(result.ok, false, `${label} is unreadable`);
      assert.ok(result.reason.length > 0, `${label} comes with a reason`);
    };
    const parsed = format.parseSnapshot('{"schema_version": 1, "sources": {');
    assert.equal(parsed.ok, false, 'a file that is not JSON is unreadable');
    unreadable('schema_version 2', { ...base(), schema_version: 2 });
    unreadable('schema_version "1"', { ...base(), schema_version: '1' });
    unreadable('no schema_version', { sources: base().sources });
    unreadable('sources []', { ...base(), sources: [] });
    unreadable('sources null', { ...base(), sources: null });
    unreadable('no sources', { schema_version: 1 });
    unreadable('a root array', [base()]);
    unreadable('a root null', null);
  }
}
