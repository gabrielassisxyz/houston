// The chain routes over real `br` trackers: the chain of a bead in a project,
// and the links of an identifier across every project. Skipped when `br` is not
// installed. Beads are written with the `br` CLI, not through the API, so this
// passes under both launch modes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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

const STRY = 'STRY00000001';
const json = { 'Content-Type': 'application/json' };
const dirs = [];
const registered = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const brIn = (cwd, args) => execFileSync(BR, args, { cwd, encoding: 'utf8' });
const create = (cwd, title, { type = 'task', ref, parent } = {}) => {
  const args = ['--json', 'create', `--type=${type}`, '--priority=2'];
  if (ref) args.push(`--external-ref=${ref}`);
  if (parent) args.push(`--parent=${parent}`);
  args.push('--', title);
  return JSON.parse(brIn(cwd, args)).id;
};
const initTracker = (dir) => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  brIn(dir, ['init', '--prefix', 'bd']);
};
const register = async (dir) => {
  const res = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(res.status, 201, `register ${dir}: ${await res.clone().text()}`);
  const id = (await res.json()).id;
  registered.push(id);
  return id;
};
const patchProject = async (id, patch) => {
  const res = await fetch(`${base}/api/projects/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(patch) });
  assert.equal(res.status, 200, `patch ${id}: ${await res.clone().text()}`);
};
const putConfig = async (patch) => {
  const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: json, body: JSON.stringify(patch) });
  assert.equal(res.status, 200, `config: ${await res.clone().text()}`);
};
// Every answer of both routes, 400 and 404 included, carries no-store.
const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  assert.equal(res.headers.get('cache-control'), 'no-store', `${p}: cache-control`);
  return { status: res.status, body: await res.json() };
};

try {
  // Tracker A: an epic with the story reference, a child, a grandchild with
  // a task reference. Tracker B: an epic carrying the same story reference.
  const a = tmp('scotty-chain-a-');
  initTracker(a);
  const epicA = create(a, 'the epic', { type: 'epic', ref: STRY });
  const childA = create(a, 'the child', { parent: epicA });
  const grandA = create(a, 'the grandchild', { parent: childA, ref: 'BUG00000001' });
  const b = tmp('scotty-chain-b-');
  initTracker(b);
  const epicB = create(b, 'the other epic', { type: 'epic', ref: STRY });
  const snapDir = tmp('scotty-chain-snap-');
  const copy = path.join(snapDir, 'snapshot.json');
  fs.copyFileSync(new URL('./fixtures/snapshot-v1.json', import.meta.url), copy);

  const aId = await register(a);
  const bId = await register(b);
  await patchProject(aId, { pipelineRepo: 'org/repo-a' });
  await patchProject(bId, { pipelineRepo: 'org/repo-a' });
  await putConfig({ snapshotPath: copy, serviceNowHost: 'example.com', githubOrgs: ['org'] });

  // Without a notes service the chain carries no notes part.
  {
    const { body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
    assert.ok(!('notes' in body), 'unconfigured: no notes part');
    const links = await get(`/api/links/${STRY}`);
    assert.ok(!('notes' in links.body), 'unconfigured links: no top-level notes');
    for (const entry of links.body.beads.filter((e) => [aId, bId].includes(e.projectId))) {
      assert.ok(!('notes' in entry.chain), 'unconfigured links: no notes in a bead chain');
    }
  }

  // The chain of the epic and of the grandchild, with the shape and states of
  // the resolver and their links.
  {
    const { status, body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
    assert.equal(status, 200);
    assert.equal(body.bead.id, epicA);
    assert.equal(body.tracker.state, 'found');
    assert.equal(body.tracker.number, STRY);
    assert.ok(body.tracker.link.startsWith('https://example.com/'), 'tracker link on the configured host');
    assert.equal(body.snapshot.available, true);
    assert.equal(body.pipeline.state, 'found');
    assert.ok(body.pipeline.runs.length > 0);
    assert.ok(body.pipeline.runs[0].link.includes('github.com/org/repo-a'), 'run link on the allowed owner');
    assert.deepEqual(body.descendants.map((d) => d.id).sort(), [childA, grandA].sort());
    const grand = body.descendants.find((d) => d.id === grandA);
    assert.equal(grand.tracker.state, 'found');
    assert.equal(grand.tracker.number, 'BUG00000001');
  }
  {
    const { status, body } = await get(`/api/p/${aId}/beads/${grandA}/chain`);
    assert.equal(status, 200);
    assert.equal(body.epic.id, epicA);
    assert.equal(body.epic.tracker.number, STRY);
    assert.equal(body.tracker.number, 'BUG00000001');
    assert.equal(body.pipeline.state, 'found');
  }

  // The server reads its own checkout too; the test only judges its own projects.
  let cId = null;
  const ownIds = () => (cId === null ? [aId, bId] : [aId, bId, cId]);
  const own = (body) => body.beads.filter((e) => ownIds().includes(e.projectId));
  const ownUnreadable = (body) => body.unreadable.filter((e) => ownIds().includes(e.id));
  // The links of the story, upper and lower case: both epics, each with its chain.
  for (const id of [STRY, STRY.toLowerCase()]) {
    const { status, body } = await get(`/api/links/${id}`);
    assert.equal(status, 200, `links ${id}`);
    assert.equal(body.id, id, 'the identifier answered back trimmed as given');
    assert.equal(body.snapshot.available, true);
    assert.equal(body.ticket.state, 'found');
    assert.equal(body.ticket.number, STRY);
    assert.equal(own(body).length, 2, `links ${id}: the epics in both projects`);
    assert.deepEqual(own(body).map((e) => e.projectId).sort(), [aId, bId].sort());
    assert.deepEqual(own(body).map((e) => e.chain.bead.id).sort(), [epicA, epicB].sort(), 'each entry carries its chain');
    for (const entry of own(body)) {
      assert.equal(entry.chain.tracker.number, STRY);
      assert.ok(entry.projectName.length > 0);
    }
    assert.deepEqual(ownUnreadable(body), []);
  }
  // A bead id returns its bead; an incident no bead carries returns the
  // ticket and no bead.
  {
    const { status, body } = await get(`/api/links/${childA}`);
    assert.equal(status, 200);
    assert.equal(own(body).length, 1);
    assert.equal(own(body)[0].chain.bead.id, childA);
  }
  {
    const { status, body } = await get('/api/links/INC00000001');
    assert.equal(status, 200);
    assert.deepEqual(own(body), []);
    assert.equal(body.ticket.state, 'found');
    assert.equal(body.ticket.number, 'INC00000001');
  }

  // A third project, readable while registered and broken afterwards, is
  // named under `unreadable` while the others are still answered.
  const c = tmp('scotty-chain-c-');
  initTracker(c);
  create(c, 'doomed project bead');
  cId = await register(c);
  assert.equal((await get(`/api/links/${STRY}`)).status, 200);
  assert.deepEqual(ownUnreadable((await get(`/api/links/${STRY}`)).body), [], 'the third project reads while its file exists');
  fs.rmSync(path.join(c, '.beads', 'issues.jsonl'));
  {
    const { status, body } = await get(`/api/links/${STRY}`);
    assert.equal(status, 200);
    assert.equal(ownUnreadable(body).length, 1, JSON.stringify(ownUnreadable(body)));
    assert.equal(ownUnreadable(body)[0].id, cId);
    assert.ok(ownUnreadable(body)[0].name.length > 0);
    assert.ok(ownUnreadable(body)[0].error.length > 0, 'the failure says why');
    assert.equal(own(body).length, 2, 'the others are still answered');
  }

  // With a stub notes service on 127.0.0.1 port 0: the chain gains its
  // notes, the links gain per-bead notes and a top-level notes, including an
  // identifier no bead carries. Then with it stopped, every notes part reads
  // unavailable and everything else is unchanged.
  const stubRequests = [];
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    stubRequests.push({ path: url.pathname, ids: url.searchParams.get('ids'), hop: url.searchParams.get('hop') });
    if (url.pathname !== '/api/notes/refs') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no fixture' }));
      return;
    }
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const first = ids[0] ?? 'unknown';
    const answer = {
      notes: [
        { id: 'stub-plano', title: 'Stub plan', path: 'plans/stub.md', kind: 'plano', tags: [], matchedRefs: [first] },
        { id: 'stub-nota', title: 'Stub note', path: 'notes/stub.md', kind: 'nota', tags: ['t'], matchedRefs: [first] },
      ],
      linked: [{ id: 'stub-linked', title: 'Stub linked', path: 'linked/stub.md', kind: 'evidencia', tags: [] }],
      linkedOmitted: 0,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}/`;
  try {
    await putConfig({ notesServiceUrl: stubUrl });
    {
      const { body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
      assert.equal(body.notes?.state, 'available', 'stub: chain notes available');
      assert.equal(body.notes.plano[0]?.id, 'stub-plano', 'stub: plano grouped');
      assert.equal(body.notes.nota[0]?.id, 'stub-nota', 'stub: nota grouped');
      assert.deepEqual(body.notes.implementacao, [], 'stub: empty implementacao');
      assert.deepEqual(body.notes.evidencia, [], 'stub: no direct evidencia');
      assert.equal(body.notes.linked[0]?.id, 'stub-linked', 'stub: linked');
      assert.equal(body.notes.linkedOmitted, 0, 'stub: linkedOmitted');
      assert.equal(body.tracker.state, 'found', 'stub: tracker unchanged');
      assert.equal(body.pipeline.state, 'found', 'stub: pipeline unchanged');
    }
    {
      const { body } = await get(`/api/links/${STRY}`);
      assert.equal(body.notes?.state, 'available', 'stub links: top-level notes available');
      assert.equal(body.notes.plano[0]?.id, 'stub-plano', 'stub links: top-level plano');
      for (const entry of own(body)) {
        assert.equal(entry.chain.notes?.state, 'available', 'stub links: per-bead notes available');
      }
      assert.equal(body.ticket.state, 'found', 'stub links: ticket unchanged');
    }
    {
      const { body } = await get('/api/links/INC00000001');
      assert.deepEqual(own(body), [], 'stub: still no bead carries the incident');
      assert.equal(body.notes?.state, 'available', 'stub: an identifier no bead carries still returns its notes');
      assert.equal(body.notes.plano[0]?.id, 'stub-plano', 'stub: top-level plano for the carried identifier');
    }
    assert.ok(stubRequests.length > 0, 'the stub was called');
    for (const r of stubRequests) {
      assert.equal(r.path, '/api/notes/refs', 'the hub calls the refs route');
      assert.equal(r.hop, '1', 'the hub calls with hop=1');
      assert.ok((r.ids ?? '').split(',').length <= 200, 'the hub batches at most 200 identifiers');
    }
  } finally {
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
  // With the stub stopped the chain still answers, saying the notes are
  // unavailable, and everything else is unchanged.
  {
    const { body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
    assert.equal(body.notes?.state, 'unavailable', 'stopped: chain notes unavailable');
    assert.ok(typeof body.notes?.reason === 'string' && body.notes.reason.length > 0, 'stopped: the reason says why');
    assert.equal(body.tracker.state, 'found', 'stopped: tracker unchanged');
    assert.equal(body.pipeline.state, 'found', 'stopped: pipeline unchanged');
    const links = await get(`/api/links/${STRY}`);
    assert.equal(links.body.notes?.state, 'unavailable', 'stopped links: top-level unavailable');
    for (const entry of own(links.body)) {
      assert.equal(entry.chain.notes?.state, 'unavailable', 'stopped links: per-bead unavailable');
    }
  }
  await putConfig({ notesServiceUrl: '' });

  // Rewriting the copy atomically: the next answer reflects it.
  {
    const doc = JSON.parse(fs.readFileSync(copy, 'utf8'));
    doc.sources.work_tracker_stories.records[0].title = 'Rewritten synthetic story';
    const next = `${copy}.new`;
    fs.writeFileSync(next, JSON.stringify(doc));
    fs.renameSync(next, copy);
    const { body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
    assert.equal(body.tracker.title, 'Rewritten synthetic story');
  }

  // Removing the copy: every snapshot item is unconfirmed.
  fs.rmSync(copy);
  {
    const { body } = await get(`/api/p/${aId}/beads/${epicA}/chain`);
    assert.equal(body.tracker.state, 'unconfirmed');
    assert.ok(body.tracker.reason.length > 0);
    assert.equal(body.pipeline.state, 'unconfirmed');
    assert.equal(body.snapshot.available, false);
  }
  {
    const { body } = await get(`/api/links/${STRY}`);
    assert.equal(body.snapshot.available, false);
    assert.equal(body.ticket.state, 'unconfirmed');
  }

  // With the path cleared the links still answer 200 with an unavailable
  // snapshot and an unconfirmed ticket, and a demo bead's chain has no
  // pipeline part.
  await putConfig({ snapshotPath: '' });
  {
    const { status, body } = await get(`/api/links/${STRY}`);
    assert.equal(status, 200);
    assert.equal(body.snapshot.available, false);
    assert.equal(body.ticket.state, 'unconfirmed');
    assert.deepEqual(body.ticket.approvals, []);
  }
  {
    const listed = await (await fetch(`${base}/api/p/demo/beads`)).json();
    const { status, body } = await get(`/api/p/demo/beads/${listed.beads[0].id}/chain`);
    assert.equal(status, 200);
    assert.ok(!('pipeline' in body), 'the demo has no pipeline part');
  }

  // Unknown projects and beads answer 404; bad identifiers answer 400.
  for (const p of [`/api/p/no-such-project-xyz/beads/x/chain`, `/api/p/@all/beads/x/chain`, `/api/p/${aId}/beads/no-such-bead-xyz/chain`]) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal((await get(`/api/links/${'A'.repeat(129)}`)).status, 400, 'a 129-character identifier');
  assert.equal((await get('/api/links/%20%20')).status, 400, 'a whitespace-only identifier');
  assert.equal((await get('/api/links/%00')).status, 400, 'an identifier holding a NUL');
  assert.equal((await fetch(`${base}/api/links/`)).status, 404, 'a bare links path matches no route');

  console.log('PASS (server): chain and links over real br trackers');
} finally {
  for (const id of registered) await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  await putConfig({ snapshotPath: '', serviceNowHost: '', githubOrgs: null, notesServiceUrl: '' });
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
