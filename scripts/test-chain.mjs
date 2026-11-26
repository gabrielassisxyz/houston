// Pure test of lib/chain.ts, without a build or a server: the chain of a bead over
// scripts/fixtures/snapshot-v1.json and copies of it edited case by case, with synthetic beads
// whose hierarchy is held in parent-child edges only, never in a `parent` field.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleCache = new Map();

// esModuleInterop, because without it `import fs from "node:fs"` compiles to an undefined
// `node_fs_1.default`. Memoized, so the chain and this script share one snapshot-format.
function load(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const exports = {};
  moduleCache.set(name, exports);
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, { filename: `lib/${name}.ts` });
  wrapper(exports, (id) => (id.startsWith('./') ? load(id.slice(2)) : require(id)));
  return exports;
}

const format = load('snapshot-format');
const { resolveChain, collectChainRefIds, mergeNotesAnswers, groupNotesAnswer } = load('chain');

const fixtureText = readFileSync(new URL('./fixtures/snapshot-v1.json', import.meta.url), 'utf8');
const base = () => JSON.parse(fixtureText);
const SETTINGS = { serviceNowHost: 'example.com', githubOrgs: ['org'] };
const PROJECT_A = { id: 'proj', pipelineRepo: 'org/repo-a' };
const PROJECT_B = { id: 'proj-b', pipelineRepo: 'org/repo-b' };
const NO_PIPELINE = { id: 'proj' };
const DEMO = { id: 'demo', name: 'Demo', path: null };
const UNAVAILABLE = { available: false, reason: 'the snapshot file does not exist' };
const HISTORICAL_AT = '2026-11-19T08:00:00Z';
const APPROVALS_AT = '2026-11-19T12:00:30.123456+00:00';

function available(doc) {
  const parsed = format.readSnapshotDocument(doc);
  assert.equal(parsed.ok, true, 'the edited fixture still reads');
  return { available: true, snapshot: parsed.snapshot };
}
const FIXTURE = available(base());

function edited(edit) {
  const doc = base();
  edit(doc.sources);
  return available(doc);
}
const whole = (envelope) => Object.assign(envelope, { status: 'ok', complete: true, error: null });
const allBeads = [];

function bead(id, type, { parents = [], ref, extra = [] } = {}) {
  const made = {
    id,
    title: `Title ${id}`,
    status: 'open',
    issue_type: type,
    dependencies: [
      ...parents.map((parent) => ({ issue_id: id, depends_on_id: parent, type: 'parent-child' })),
      ...extra.map(([to, depType]) => ({ issue_id: id, depends_on_id: to, type: depType })),
    ],
  };
  if (ref !== undefined) made.external_ref = ref;
  allBeads.push(made);
  return made;
}

// Every answer is plain JSON in camelCase, and a time of last confirmation stands only beside
// `historical`. Checked on every chain any case below resolves.
function checkShape(value, at) {
  if (Array.isArray(value)) return value.forEach((item, i) => checkShape(item, `${at}[${i}]`));
  assert.notEqual(value, undefined, `${at} is never undefined`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    assert.match(key, /^[a-z][A-Za-z0-9]*$/, `${at}.${key} is camelCase`);
    checkShape(inner, `${at}.${key}`);
  }
  if ('lastConfirmedAt' in value) assert.equal(value.freshness, 'historical', `${at}: lastConfirmedAt only when historical`);
  if (value.freshness === 'historical') assert.equal(typeof value.lastConfirmedAt, 'string', `${at}: historical has a time`);
}

function chainOf(target, beads, project, read, settings = SETTINGS, notes) {
  const chain = resolveChain(target, beads, project, read, settings, notes);
  checkShape(chain, 'chain');
  assert.deepEqual(JSON.parse(JSON.stringify(chain)), chain, 'the chain survives JSON unchanged');
  return chain;
}

// ------------------------------------------------------------------ expected parts of the fixture

const STORY = {
  state: 'found', freshness: 'confirmed', source: 'work_tracker_stories', number: 'STRY00000001',
  title: 'Synthetic story', status: 'Work in progress', sprint: 'sprint-a',
  link: 'https://example.com/rm_story.do?sys_id=00000000000000000000000000000031', approvals: [],
};
const INCIDENT = {
  state: 'found', freshness: 'confirmed', source: 'incidents', number: 'INC00000001', title: 'Synthetic incident',
  status: 'Example state', link: 'https://example.com/incident.do?sys_id=00000000000000000000000000000001', approvals: [],
};
const approval = (n, title) => ({
  number: `CHG0000000${n}`, title, recordType: 'change_request', state: 'Requested',
  link: `https://example.com/sysapproval_approver.do?sys_id=0000000000000000000000000000001${n}`,
  freshness: 'historical', lastConfirmedAt: APPROVALS_AT,
});
const OTHER_TEAMS_CHANGE = { state: 'absent', approvals: [approval(2, 'Synthetic change outside the collected scope')] };
const RUN_101 = {
  id: 101, createdAt: '2026-11-20T11:00:00Z', status: 'waiting', conclusion: null, head: 'release/example-a',
  link: 'https://github.com/org/repo-a/actions/runs/101',
  existingPrs: [{ number: 201, link: 'https://github.com/org/repo-a/pull/201' }],
};
const PR_201 = {
  number: 201, base: 'main', head: 'release/example-a', anomalies: ['stale_release'],
  link: 'https://github.com/org/repo-a/pull/201',
};
const CHANGE_1 = { number: 'CHG00000001', link: 'https://example.com/change_request.do?sys_id=00000000000000000000000000000021' };
const ISSUE_A = { part: 'annotations', repo: 'org/repo-a', runId: 101, error: 'The read command did not finish.' };
const ISSUE_B = { part: 'pulls', repo: 'org/repo-b', error: 'The read command did not finish.' };
const BUDGET = { part: 'budget', limit: 120 };
const PIPELINE_A = {
  state: 'found', freshness: 'partial', runs: [RUN_101], prs: [PR_201], issues: [ISSUE_A, BUDGET], changes: [CHANGE_1],
};

// ---------------------------------------------------------------------------------- hierarchy

const epic = bead('E', 'epic', { ref: 'STRY00000001' });
const child = bead('T1', 'task', { parents: ['E'], ref: 'INC00000001' });
bead('T2', 'task', { parents: ['E'] });
const grandchild = bead('G', 'task', { parents: ['T1'], ref: '  CHG00000002 ' });
const greatSibling = bead('F', 'feature', { parents: ['T2'], ref: 'STRY00000009' });
bead('X', 'task', { extra: [['E', 'blocks']] });
const outer = bead('E0', 'epic');
bead('E1', 'epic', { parents: ['E0'] });
const inner = bead('T3', 'task', { parents: ['E1'] });
const orphanParent = bead('P', 'task');
const orphan = bead('Q', 'task', { parents: ['P'] });
const selfParent = bead('S', 'task', { parents: ['S'] });
bead('A', 'task', { parents: ['B'] });
bead('B', 'task', { parents: ['C'] });
bead('C', 'task', { parents: ['A'] });
const intoCycle = bead('D', 'task', { parents: ['A'] });
const loose = bead('R', 'task');
const beads = allBeads.slice();
for (const b of beads) assert.ok(!('parent' in b), `${b.id} has no parent field: the hierarchy is in the edges`);

const GRANDCHILD_PART = { id: 'G', type: 'task', status: 'open', title: 'Title G', externalRef: 'CHG00000002', tracker: OTHER_TEAMS_CHANGE };
const EPIC_PART = { id: 'E', status: 'open', title: 'Title E', externalRef: 'STRY00000001', tracker: STORY };

// The chain of an epic over the fixture: every bead under it, two levels deep, nearest first.
{
  const chain = chainOf(epic, beads, PROJECT_A, FIXTURE);
  assert.deepEqual(chain, {
    bead: { id: 'E', projectId: 'proj', type: 'epic', status: 'open', title: 'Title E', externalRef: 'STRY00000001' },
    tracker: STORY,
    descendants: [
      { id: 'T1', type: 'task', status: 'open', title: 'Title T1', externalRef: 'INC00000001', tracker: INCIDENT },
      { id: 'T2', type: 'task', status: 'open', title: 'Title T2', tracker: null },
      GRANDCHILD_PART,
      { id: 'F', type: 'feature', status: 'open', title: 'Title F', externalRef: 'STRY00000009', tracker: { state: 'absent', approvals: [] } },
    ],
    pipeline: PIPELINE_A,
    snapshot: { available: true },
  }, 'epic chain over the fixture');
  assert.ok(!('epic' in chain), 'an epic carries no enclosing epic');
}

// The chain of a task two levels under the epic: its nearest enclosing epic, by the edges.
{
  const chain = chainOf(grandchild, beads, PROJECT_A, FIXTURE);
  assert.deepEqual(chain.epic, EPIC_PART, 'task two levels up: nearest epic by the parent-child edge');
  assert.deepEqual(chain, {
    bead: { id: 'G', projectId: 'proj', type: 'task', status: 'open', title: 'Title G', externalRef: 'CHG00000002' },
    tracker: OTHER_TEAMS_CHANGE,
    epic: EPIC_PART,
    pipeline: PIPELINE_A,
    snapshot: { available: true },
  }, 'task chain over the fixture');
  assert.ok(!('descendants' in chain), 'a task carries no descendants');
  assert.deepEqual(chainOf(child, beads, PROJECT_A, FIXTURE).epic, EPIC_PART, 'task one level up');
  assert.deepEqual(chainOf(greatSibling, beads, PROJECT_A, FIXTURE).epic, EPIC_PART, 'feature two levels up');
}

// The nearest epic wins, a chain with no epic above it has none, and loops end the walk.
{
  assert.equal(chainOf(inner, beads, NO_PIPELINE, FIXTURE).epic.id, 'E1', 'the nearest epic, not the outer one');
  assert.deepEqual(chainOf(outer, beads, NO_PIPELINE, FIXTURE).descendants.map((d) => d.id), ['E1', 'T3'], 'an epic under an epic');
  assert.equal(chainOf(orphan, beads, NO_PIPELINE, FIXTURE).epic, null, 'no epic above: null');
  assert.equal(chainOf(orphanParent, beads, NO_PIPELINE, FIXTURE).epic, null, 'no parent at all: null');
  assert.equal(chainOf(selfParent, beads, NO_PIPELINE, FIXTURE).epic, null, 'its own parent: the walk ends');
  assert.equal(chainOf(beads.find((b) => b.id === 'A'), beads, NO_PIPELINE, FIXTURE).epic, null, 'a three-bead cycle ends');
  assert.equal(chainOf(intoCycle, beads, NO_PIPELINE, FIXTURE).epic, null, 'a walk into a cycle ends at the bead met twice');
}

// --------------------------------------------------------------------------------- references

// A blank, null or missing reference makes no lookup: a snapshot that throws on any read is
// never touched.
{
  const trap = new Proxy({}, { get() { throw new Error('the snapshot was read'); } });
  for (const ref of ['   ', '', null, undefined]) {
    const target = { ...loose };
    if (ref !== undefined) target.external_ref = ref;
    const chain = chainOf(target, beads, NO_PIPELINE, { available: true, snapshot: trap });
    assert.equal(chain.tracker, null, `reference ${JSON.stringify(ref)}: no tracker item`);
    assert.ok(!('externalRef' in chain.bead), `reference ${JSON.stringify(ref)}: no externalRef`);
  }
}

const trackerOf = (ref, read, settings) => chainOf({ ...loose, external_ref: ref }, beads, NO_PIPELINE, read, settings).tracker;

// Each tracker state.
{
  assert.deepEqual(trackerOf(' stry00000001 ', FIXTURE), STORY, 'found, trimmed and without regard to case');
  assert.equal(chainOf({ ...loose, external_ref: ' STRY00000001 ' }, beads, NO_PIPELINE, FIXTURE).bead.externalRef, 'STRY00000001', 'externalRef trimmed');
  const bug = trackerOf('BUG00000001', FIXTURE);
  assert.equal(bug.state, 'found', 'a bug is found');
  assert.ok(!('sprint' in bug), 'an empty sprint is left out');
  assert.deepEqual(trackerOf('CHG00000001', FIXTURE), {
    state: 'found', freshness: 'confirmed', source: 'changes', number: 'CHG00000001', title: 'Synthetic change',
    status: 'Scheduled', link: CHANGE_1.link, approvals: [approval(1, 'Synthetic change')],
  }, 'a change found with its own approval');
  const historical = edited((s) => Object.assign(s.work_tracker_stories, { status: 'error', complete: false, last_success_at: HISTORICAL_AT }));
  assert.deepEqual(trackerOf('STRY00000001', historical), { ...STORY, freshness: 'historical', lastConfirmedAt: HISTORICAL_AT }, 'found, historical');
  const partial = edited((s) => Object.assign(s.work_tracker_stories, { complete: false, last_success_at: null }));
  assert.deepEqual(trackerOf('STRY00000001', partial), { ...STORY, freshness: 'partial' }, 'found, partial, no time');
  const otherHost = { serviceNowHost: 'other.example.com', githubOrgs: ['org'] };
  assert.equal(trackerOf('STRY00000001', FIXTURE, otherHost).link, null, 'a link off the configured host is null');
  assert.equal(trackerOf('CHG00000001', FIXTURE, otherHost).approvals[0].link, null, 'an approval link off the host is null');
  assert.deepEqual(trackerOf('STRY00000009', FIXTURE), { state: 'absent', approvals: [] }, 'absent');
  const unread = edited((s) => {
    s.ritms.complete = false;
    s.work_tracker_stories.status = 'auth_expired';
    s.incidents.status = 'error';
    delete s.work_tracker_subtasks;
  });
  assert.deepEqual(trackerOf('STRY00000009', unread), {
    state: 'unconfirmed',
    reason: 'ticket sources not collected ok and complete: incidents (error), work_tracker_stories (auth_expired), work_tracker_subtasks (not_collected), ritms (partial)',
    approvals: [],
  }, 'unconfirmed, with the unread sources in their fixed order');
  assert.equal(trackerOf('STRY00000001', unread).state, 'found', 'a hit in what was read is still found');
}

// A story known only through a pending approval, and another team's change waiting on the
// user: an item that is absent, or unconfirmed, and still carries the approval.
{
  const pending = {
    key: '00000000000000000000000000000014', number: 'STRY00000002', title: 'Synthetic story awaiting approval',
    state: 'Requested', record_type: 'rm_story', link: 'https://example.com/sysapproval_approver.do?sys_id=00000000000000000000000000000014',
  };
  const expected = {
    number: 'STRY00000002', title: 'Synthetic story awaiting approval', recordType: 'rm_story', state: 'Requested',
    link: pending.link, freshness: 'historical', lastConfirmedAt: APPROVALS_AT,
  };
  const known = edited((s) => s.approvals.records.push(pending));
  assert.deepEqual(trackerOf('STRY00000002', known), { state: 'absent', approvals: [expected] }, 'a story only an approval names');
  const unknown = edited((s) => {
    s.approvals.records.push(pending);
    s.work_tracker_stories.status = 'error';
  });
  assert.deepEqual(trackerOf('STRY00000002', unknown), {
    state: 'unconfirmed', reason: 'ticket sources not collected ok and complete: work_tracker_stories (error)', approvals: [expected],
  }, 'unconfirmed, still carrying the approval');
  assert.deepEqual(trackerOf('CHG00000002', FIXTURE), OTHER_TEAMS_CHANGE, "another team's change waiting for approval");
}

// An unavailable snapshot makes every item, and the pipeline, unconfirmed with its reason.
{
  const reason = UNAVAILABLE.reason;
  const unconfirmed = { state: 'unconfirmed', reason, approvals: [] };
  const chain = chainOf(epic, beads, PROJECT_A, UNAVAILABLE);
  assert.deepEqual(chain.tracker, unconfirmed, 'the bead item');
  assert.deepEqual(chain.descendants.map((d) => d.tracker), [unconfirmed, null, unconfirmed, unconfirmed], 'each descendant');
  assert.deepEqual(chain.pipeline, { state: 'unconfirmed', reason }, 'the pipeline');
  assert.deepEqual(chain.snapshot, { available: false, reason }, 'the snapshot part');
  assert.deepEqual(chainOf(grandchild, beads, PROJECT_A, UNAVAILABLE).epic.tracker, unconfirmed, 'the epic item');
}

// ----------------------------------------------------------------------------------- pipeline

const pipelineOf = (read, project = PROJECT_A, settings = SETTINGS) => chainOf(loose, beads, project, read, settings).pipeline;
const withRecords = (records, envelope = whole) =>
  edited((s) => {
    envelope(s.pipeline);
    s.pipeline.records = records;
  });
const fixtureRecords = () => base().sources.pipeline.records;
const byKey = (...keys) => fixtureRecords().filter((r) => keys.includes(r.key));

// Runs or pull requests with a collection issue for the repository, or the budget issue: found,
// partial, the issues shown, and no time of last confirmation even when the envelope has one.
{
  assert.deepEqual(pipelineOf(FIXTURE), PIPELINE_A, 'the fixture for org/repo-a');
  assert.deepEqual(pipelineOf(FIXTURE, PROJECT_B), {
    state: 'found', freshness: 'partial', runs: [{
      id: 102, createdAt: '2026-11-20T10:00:00Z', status: 'completed', conclusion: 'success', head: null,
      link: 'https://github.com/org/repo-b/actions/runs/102', existingPrs: [],
    }], prs: [], issues: [ISSUE_B, BUDGET], changes: [],
  }, 'the fixture for org/repo-b: a null run_id is left out');
  const dated = edited((s) => Object.assign(s.pipeline, { last_success_at: HISTORICAL_AT }));
  assert.equal(dated.snapshot.pipeline.freshness.state, 'historical', 'precondition: the envelope alone reads historical');
  const partial = pipelineOf(dated);
  assert.equal(partial.freshness, 'partial', 'an issue makes the pipeline partial');
  assert.ok(!('lastConfirmedAt' in partial), 'a partial pipeline has no lastConfirmedAt despite last_success_at');
  const budgetOnly = pipelineOf(withRecords(byKey('run:org/repo-a:101', 'issue:budget')));
  assert.deepEqual([budgetOnly.state, budgetOnly.freshness, budgetOnly.issues], ['found', 'partial', [BUDGET]], 'the budget issue alone');
}

// Runs or pull requests and no issue: found, with the pipeline source's freshness.
{
  const clean = byKey('run:org/repo-a:101', 'pr:org/repo-a:201');
  assert.deepEqual(pipelineOf(withRecords(clean)), { ...PIPELINE_A, freshness: 'confirmed', issues: [] }, 'found, confirmed');
  const old = withRecords(clean, (e) => Object.assign(e, { status: 'error', complete: false, last_success_at: HISTORICAL_AT }));
  assert.deepEqual(pipelineOf(old), { ...PIPELINE_A, freshness: 'historical', lastConfirmedAt: HISTORICAL_AT, issues: [] }, 'found, historical');
  const prsOnly = pipelineOf(withRecords(byKey('pr:org/repo-a:201')));
  assert.deepEqual([prsOnly.state, prsOnly.runs, prsOnly.prs, prsOnly.changes], ['found', [], [PR_201], []], 'pull requests alone are found');
}

// Nothing for the repository, with an issue or a source not wholly read: unconfirmed, never absent.
{
  assert.deepEqual(pipelineOf(withRecords(byKey('issue:org/repo-a:annotations:101', 'run:org/repo-b:102'))), {
    state: 'unconfirmed',
    reason: 'the annotations collection for org/repo-a run 101 failed: The read command did not finish.',
    issues: [ISSUE_A],
  }, 'a repository issue with no runs: unconfirmed, not absent');
  assert.deepEqual(pipelineOf(withRecords(byKey('issue:budget'))), {
    state: 'unconfirmed', reason: 'the collection reached its budget limit of 120', issues: [BUDGET],
  }, 'the budget issue with no runs: unconfirmed, not absent');
  const errorNull = pipelineOf(withRecords([], (e) => Object.assign(e, { status: 'error', complete: false, error: null })));
  assert.deepEqual(errorNull, { state: 'unconfirmed', reason: "the pipeline source's status is error" }, 'error with error: null');
  assert.ok(!errorNull.reason.includes('null'), 'the reason never says null');
  const blank = pipelineOf(withRecords([], (e) => Object.assign(e, { status: 'error', complete: false, error: '  ' })));
  assert.equal(blank.reason, "the pipeline source's status is error", 'a blank error adds no clause');
  const both = pipelineOf(withRecords(byKey('issue:budget'), (e) => Object.assign(e, { status: 'error', complete: false, error: 'Source consultation failed.' })));
  assert.equal(both.reason, "the pipeline source's status is error: Source consultation failed.; the collection reached its budget limit of 120", 'source and issue');
  assert.deepEqual(pipelineOf(withRecords([], (e) => Object.assign(whole(e), { complete: false }))), {
    state: 'unconfirmed', reason: "the pipeline source's status is partial",
  }, 'ok but incomplete reads as partial');
  const missing = edited((s) => delete s.pipeline);
  assert.deepEqual(pipelineOf(missing), { state: 'unconfirmed', reason: "the pipeline source's status is not_collected" }, 'no pipeline source');
}

// Nothing for the repository and the source whole: absent. A second repository's runs, pull
// requests, changes and issue are left out, and never change the first repository's state.
{
  const otherRepo = [
    ...byKey('run:org/repo-b:102', 'issue:org/repo-b:pulls'),
    { key: 'run:org/repo-b:103', kind: 'run', repo: 'org/repo-b', id: 103, created_at: '2026-11-21T00:00:00Z', status: 'waiting', conclusion: null, head: 'x', changes: ['CHG00000007'], existing_prs: [301] },
    { key: 'pr:org/repo-b:301', kind: 'pr', repo: 'org/repo-b', number: 301, base: 'main', head: 'x', anomalies: [] },
  ];
  assert.deepEqual(pipelineOf(withRecords(otherRepo)), { state: 'absent' }, 'absent: only another repository has records');
  const own = byKey('run:org/repo-a:101', 'pr:org/repo-a:201');
  const alone = pipelineOf(withRecords(own));
  assert.deepEqual(pipelineOf(withRecords([...otherRepo, ...own])), alone, "another repository's records change nothing");
  assert.deepEqual(alone, { ...PIPELINE_A, freshness: 'confirmed', issues: [] }, 'only the own repository is shown');
}

// Runs newest first, then by id; pull requests by number; changes trimmed, without blanks, and
// de-duplicated without regard to case, keeping the first spelling met in that run order.
{
  const run = (id, createdAt, changes) => ({ key: `run:${id}`, kind: 'run', repo: 'org/repo-a', id, created_at: createdAt, status: 'waiting', conclusion: null, head: null, changes });
  const pr = (number) => ({ key: `pr:${number}`, kind: 'pr', repo: 'org/repo-a', number, base: 'main', head: 'h', anomalies: [] });
  const records = [
    run(5, '2026-11-20T10:00:00Z', ['CHG00000001', 'Chg00000004']),
    run(6, '2026-11-20T11:00:00Z', ['CHG00000003', '', '   ', 'CHG00000004']),
    run(9, '2026-11-20T09:00:00Z', []),
    run(7, '2026-11-20T11:00:00Z', ['chg00000005', ' CHG00000003 ']),
    pr(3), pr(12), pr(7),
  ];
  const pipeline = pipelineOf(withRecords(records));
  assert.deepEqual(pipeline.runs.map((r) => r.id), [7, 6, 5, 9], 'runs newest first, then id descending');
  assert.deepEqual(pipeline.prs.map((p) => p.number), [12, 7, 3], 'pull requests by number descending');
  const form = (n) => `https://example.com/change_request.do?sysparm_query=number=${n}`;
  assert.deepEqual(pipeline.changes, [
    { number: 'chg00000005', link: null },
    { number: 'CHG00000003', link: form('CHG00000003') },
    { number: 'CHG00000004', link: form('CHG00000004') },
    CHANGE_1,
  ], 'changes trimmed, blanks dropped, first spelling kept');
  const refused = pipelineOf(withRecords(records), PROJECT_A, { serviceNowHost: null, githubOrgs: [] });
  assert.ok(refused.runs.every((r) => r.link === null) && refused.prs.every((p) => p.link === null), 'no allowed owner: no GitHub link');
  assert.ok(refused.changes.every((c) => c.link === null), 'no ticket host: no change link');
}

// A project without a pipeline repository, and the demo, have no pipeline part.
{
  for (const [project, label] of [[NO_PIPELINE, 'no pipelineRepo'], [DEMO, 'the demo']]) {
    for (const read of [FIXTURE, UNAVAILABLE]) {
      assert.ok(!('pipeline' in chainOf(epic, beads, project, read)), `${label}: no pipeline part`);
      assert.ok(!('pipeline' in chainOf(grandchild, beads, project, read)), `${label}: no pipeline part for a task`);
    }
  }
  assert.equal(chainOf(loose, beads, DEMO, FIXTURE).bead.projectId, 'demo', 'the demo project id');
}

// ----------------------------------------------------------------- collectChainRefIds

// An epic asks about its id, every descendant's id and every external_ref
// among them; a task asks about its id and its external_ref, never siblings'.
{
  assert.deepEqual(collectChainRefIds(epic, beads), [
    'E', 'T1', 'T2', 'G', 'F',
    'STRY00000001', 'INC00000001', 'CHG00000002', 'STRY00000009',
  ], 'epic: ids then refs, trimmed');
  assert.deepEqual(collectChainRefIds(grandchild, beads), ['G', 'CHG00000002'], 'task: its id and its ref only');
  assert.deepEqual(collectChainRefIds(beads.find((b) => b.id === 'T2'), beads), ['T2'], 'a task without a ref: its id only');
  // De-duplicated without regard to case, keeping the first spelling.
  const dupes = [
    { id: 'DUP', title: 't', status: 'open', issue_type: 'task', external_ref: 'dup', dependencies: [] },
    { id: 'other', title: 't', status: 'open', issue_type: 'task', dependencies: [] },
  ];
  assert.deepEqual(collectChainRefIds(dupes[0], dupes), ['DUP'], 'an external_ref duplicating the id case-insensitively is dropped');
}

// An external_ref holding a comma is left out: the refs route would split it.
{
  const commaRef = { id: 'C1', title: 't', status: 'open', issue_type: 'task', external_ref: 'STRY00000001,INC00000001', dependencies: [] };
  assert.deepEqual(collectChainRefIds(commaRef, [commaRef]), ['C1'], 'a comma ref is left out for a task');
  const commaEpic = { id: 'CE', title: 't', status: 'open', issue_type: 'epic', external_ref: 'a,b', dependencies: [] };
  const commaChild = { id: 'CC', title: 't', status: 'open', issue_type: 'task', external_ref: 'STRY00000001', dependencies: [{ issue_id: 'CC', depends_on_id: 'CE', type: 'parent-child' }] };
  assert.deepEqual(collectChainRefIds(commaEpic, [commaEpic, commaChild]), ['CE', 'CC', 'STRY00000001'], 'a comma ref is left out for an epic');
}

// ----------------------------------------------------------------------------------- notes

// Without a notes answer the chain carries no notes part.
{
  assert.ok(!('notes' in chainOf(epic, beads, PROJECT_A, FIXTURE)), 'no notes answer: no notes part');
}

// A fixture refs answer is grouped by kind, then linked and linkedOmitted.
{
  const answer = {
    notes: [
      { id: 'n-plano', title: 'Plan', path: 'a/plan.md', kind: 'plano', tags: ['t'], matchedRefs: ['E'] },
      { id: 'n-impl', title: 'Impl', path: 'b/impl.md', kind: 'implementacao', tags: [], matchedRefs: ['E', 'T1'] },
      { id: 'n-evid', title: 'Evid', path: 'c/evid.md', kind: 'evidencia', tags: [], matchedRefs: ['STRY00000001'] },
      { id: 'n-nota', title: 'Note', path: 'd/note.md', kind: 'nota', tags: [], matchedRefs: ['E'] },
    ],
    linked: [{ id: 'l-1', title: 'Linked one', path: 'l/one.md', kind: 'nota', tags: [] }],
    linkedOmitted: 0,
  };
  const chain = chainOf(epic, beads, PROJECT_A, FIXTURE, SETTINGS, answer);
  assert.deepEqual(chain.notes, {
    state: 'available',
    plano: [{ id: 'n-plano', title: 'Plan', path: 'a/plan.md', kind: 'plano', tags: ['t'], matchedRefs: ['E'] }],
    implementacao: [{ id: 'n-impl', title: 'Impl', path: 'b/impl.md', kind: 'implementacao', tags: [], matchedRefs: ['E', 'T1'] }],
    evidencia: [{ id: 'n-evid', title: 'Evid', path: 'c/evid.md', kind: 'evidencia', tags: [], matchedRefs: ['STRY00000001'] }],
    nota: [{ id: 'n-nota', title: 'Note', path: 'd/note.md', kind: 'nota', tags: [], matchedRefs: ['E'] }],
    linked: [{ id: 'l-1', title: 'Linked one', path: 'l/one.md', kind: 'nota', tags: [] }],
    linkedOmitted: 0,
  }, 'notes grouped by kind');
  assert.deepEqual(groupNotesAnswer(answer).plano.map((n) => n.id), ['n-plano'], 'groupNotesAnswer groups directly');
}

// Merging two batches whose linked lists overlap: direct notes merged by id
// with matchedRefs joined, directs dropped from linked, linked de-duplicated,
// sorted by path and cut to 20, omitted summed plus the cut.
{
  const batch1 = {
    notes: [{ id: 'n-1', title: 'One', path: 'b/one.md', kind: 'plano', tags: ['b'], matchedRefs: ['E'] }],
    linked: [
      { id: 'l-common', title: 'Common', path: 'l/common.md', kind: 'nota', tags: [] },
      { id: 'l-a', title: 'A', path: 'l/a.md', kind: 'nota', tags: [] },
      { id: 'n-2', title: 'Two', path: 'a/two.md', kind: 'nota', tags: [] },
    ],
    linkedOmitted: 1,
  };
  const batch2 = {
    notes: [
      { id: 'n-1', title: 'One', path: 'b/one.md', kind: 'plano', tags: ['a'], matchedRefs: ['T1'] },
      { id: 'n-2', title: 'Two', path: 'a/two.md', kind: 'nota', tags: [], matchedRefs: ['T1'] },
    ],
    linked: [
      { id: 'l-common', title: 'Common', path: 'l/common.md', kind: 'nota', tags: [] },
      { id: 'l-b', title: 'B', path: 'l/b.md', kind: 'nota', tags: [] },
    ],
    linkedOmitted: 2,
  };
  const merged = mergeNotesAnswers([batch1, batch2]);
  assert.deepEqual(merged.notes.map((n) => n.id), ['n-2', 'n-1'], 'direct notes sorted by path');
  assert.deepEqual(merged.notes.find((n) => n.id === 'n-1').matchedRefs, ['E', 'T1'], 'matchedRefs joined and sorted');
  assert.deepEqual(merged.notes.find((n) => n.id === 'n-1').tags, ['a', 'b'], 'tags joined and sorted');
  assert.deepEqual(merged.linked.map((l) => l.id), ['l-a', 'l-b', 'l-common'], 'linked de-duplicated, directs dropped, sorted by path');
  assert.equal(merged.linkedOmitted, 3, 'omitted summed when nothing is cut');
  const chain = chainOf(epic, beads, PROJECT_A, FIXTURE, SETTINGS, merged);
  assert.equal(chain.notes.state, 'available', 'merged answer resolves to available notes');
  assert.deepEqual(chain.notes.linked.map((l) => l.id), ['l-a', 'l-b', 'l-common'], 'merged linked survives resolveChain');
}

console.log('test-chain: ok');
