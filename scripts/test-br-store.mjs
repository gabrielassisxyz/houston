// Isolated server only. Uses a throwaway br tracker; skips when br is not installed.
// A br-tracked project must open without bd, list its live beads with edges, labels and
// comments, answer 404 for an unknown id, write through br with the configured actor, refuse
// a gate plainly, and signal changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated app server');
const BR = process.env.BR_BIN || 'br';
try { execFileSync(BR, ['--version'], { stdio: 'ignore' }); } catch {
  console.log('SKIP br store: br is not installed');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-br-'));
const json = { 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configBefore = await (await fetch(`${base}/api/config`)).json();
const actor = 'Scotty Br Test Actor';
let projectId;
let writeProjectId;
let writeDir;
try {
  // cwd is always the throwaway directory: br resolves its tracker from there.
  const br = (args) => execFileSync(BR, args, { cwd: dir, encoding: 'utf8' });
  const create = (title, extra = []) => JSON.parse(br(['create', title, '--json', ...extra])).id;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  br(['init', '--prefix', 'bt']);

  const rich = create('rich bead');
  const blocker = create('blocker');
  const epic = create('epic parent', ['-t', 'epic']);
  const doomed = create('doomed');
  br(['label', 'add', rich, '-l', 'alpha,beta']);
  br(['comments', 'add', rich, 'first comment']);
  br(['comments', 'add', rich, 'second comment']);
  br(['dep', 'add', rich, blocker, '-t', 'blocks']);
  br(['dep', 'add', rich, epic, '-t', 'parent-child']);
  br(['delete', doomed, '--force']);

  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(added.status, 201);
  projectId = (await added.json()).id;
  const api = `${base}/api/p/${projectId}`;

  // List: tombstones are not beads, meta says br.
  const listRes = await fetch(`${api}/beads`);
  assert.equal(listRes.status, 200, `list: ${await listRes.clone().text()}`);
  const listed = await listRes.json();
  assert.equal(listed.meta.kind, 'br');
  assert.equal(listed.beads.length, 3, `3 live beads and 1 deleted: ${listed.beads.map((b) => b.id)}`);
  assert.ok(!listed.beads.some((b) => b.id === doomed), 'the deleted bead is not listed');

  // Comments, labels and both dependency types survive list and detail.
  const checkRich = (b, where) => {
    assert.deepEqual([...b.labels].sort(), ['alpha', 'beta'], `${where} labels`);
    assert.equal(b.comments.length, 2, `${where} comments`);
    assert.ok(b.comments.every((c) => typeof c.id === 'string'), `${where} comment ids are strings`);
    assert.deepEqual(b.comments.map((c) => c.text).sort(), ['first comment', 'second comment']);
    const deps = b.dependencies.map((d) => `${d.type}:${d.depends_on_id}`).sort();
    assert.deepEqual(deps, [`blocks:${blocker}`, `parent-child:${epic}`].sort(), `${where} deps`);
  };
  checkRich(listed.beads.find((b) => b.id === rich), 'list');
  const detailRes = await fetch(`${api}/beads/${rich}`);
  assert.equal(detailRes.status, 200, `detail: ${await detailRes.clone().text()}`);
  checkRich(await detailRes.json(), 'detail');

  // Unknown id is a 404, and so is a deleted one: br keeps a tombstone that `br show` returns.
  assert.equal((await fetch(`${api}/beads/bt-nope`)).status, 404);
  assert.equal((await fetch(`${api}/beads/${doomed}`)).status, 404, 'the deleted bead has no detail page');

  // doctor
  const doctor = await (await fetch(`${api}/doctor`)).json();
  assert.equal(doctor.kind, 'br');
  assert.equal(doctor.ok, true);
  assert.match(doctor.version, /\d/);
  assert.ok([dir, fs.realpathSync(dir)].includes(doctor.repoPath), `doctor repoPath: ${doctor.repoPath}`);

  // The one operation br has no verb for stays refused, and changes nothing.
  const gate = await fetch(`${api}/beads/${rich}/gate`, { method: 'POST', headers: json, body: JSON.stringify({}) });
  const gateBody = await gate.json();
  assert.equal(gate.status, 400, `gate answers 400: ${JSON.stringify(gateBody)}`);
  assert.equal(gateBody.code, 'unsupported', 'gate code');
  assert.ok(gateBody.error.includes('createGate'), `gate message names the operation: ${gateBody.error}`);
  assert.equal(JSON.parse(br(['show', rich, '--json']))[0].status, 'open', 'a refused write changed nothing');

  // Change stream: silent across reads, loud on a terminal write.
  const abort = new AbortController();
  const stream = await fetch(`${api}/beads/stream`, { signal: abort.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let changes = 0;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        changes += decoder.decode(value).split('event: change').length - 1;
      }
    } catch { /* aborted */ }
  })();
  await sleep(1000); // let the watcher settle after the setup writes
  changes = 0;
  for (let i = 0; i < 10; i++) {
    assert.equal((await fetch(`${api}/beads`)).status, 200);
    await sleep(300);
  }
  assert.equal(changes, 0, 'repeated reads emit no change event');
  br(['update', blocker, '--title', 'blocker renamed']);
  const deadline = Date.now() + 5000;
  while (changes === 0 && Date.now() < deadline) await sleep(100);
  assert.ok(changes > 0, 'a br update in a terminal emits a change event within 5s');
  abort.abort();
  await pump;

  // A row that fails validation is skipped; the rest still come back.
  fs.appendFileSync(path.join(dir, '.beads', 'issues.jsonl'), JSON.stringify({ id: 'bt-bad', issue_type: 'task', title: 'bad', status: 'open', priority: 'x' }) + '\n');
  const after = await (await fetch(`${api}/beads`)).json();
  assert.equal(after.beads.length, 3, 'the invalid row is skipped, the others remain');
  assert.ok(!after.beads.some((b) => b.id === 'bt-bad'));

  // ---- Writes, in a second tracker so the read-path counts above stay exact ----
  writeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-br-w-'));
  const wbr = (args) => execFileSync(BR, args, { cwd: writeDir, encoding: 'utf8' });
  const show = (id) => { const o = JSON.parse(wbr(['show', id, '--json'])); return Array.isArray(o) ? o[0] : o; };
  execFileSync('git', ['init', '-q'], { cwd: writeDir });
  wbr(['init', '--prefix', 'bw']);
  const parentId = JSON.parse(wbr(['create', 'the parent', '-t', 'epic', '--json'])).id;
  const wblocker = JSON.parse(wbr(['create', 'open blocker', '--json'])).id;
  const wadd = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: writeDir }) });
  assert.equal(wadd.status, 201);
  writeProjectId = (await wadd.json()).id;
  const wapi = `${base}/api/p/${writeProjectId}`;
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: json, body: JSON.stringify({ humanActor: actor }) })).status, 200);
  const send = (p, method, body) => fetch(`${wapi}/beads${p}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  const ok2xx = async (r, what) => { const t = await r.text(); assert.ok(r.status < 300, `${what}: ${r.status} ${t}`); return JSON.parse(t); };
  const labelsOf = (b) => [...(b.labels ?? [])].sort();
  const parentOf = (b) => (b.dependencies ?? []).filter((d) => d.dependency_type === 'parent-child').map((d) => d.id);

  // Create with every field.
  const made = await ok2xx(await send('', 'POST', {
    title: 'full bead', issue_type: 'bug', priority: 1, description: 'the details', assignee: 'someone', labels: ['a', 'b'], parent: parentId,
  }), 'create');
  const full = show(made.id);
  assert.equal(full.title, 'full bead');
  assert.equal(full.issue_type, 'bug');
  assert.equal(full.priority, 1);
  assert.equal(full.description, 'the details');
  assert.equal(full.assignee, 'someone');
  assert.deepEqual(labelsOf(full), ['a', 'b']);
  assert.deepEqual(parentOf(full), [parentId], 'parent-child edge to the parent');
  assert.equal(full.created_by, actor, 'created_by is the configured actor');
  const backlog = await ok2xx(await send('', 'POST', { title: 'later', backlog: true }), 'create backlog');
  assert.equal(show(backlog.id).status, 'deferred', 'backlog create is deferred');

  // Update: every field, label replace and clear, parent detach.
  await ok2xx(await send(`/${made.id}`, 'PATCH', { title: 'renamed', description: 'new text', priority: 3, issue_type: 'feature', assignee: 'other' }), 'patch fields');
  let b = show(made.id);
  assert.deepEqual([b.title, b.description, b.priority, b.issue_type, b.assignee], ['renamed', 'new text', 3, 'feature', 'other']);
  await ok2xx(await send(`/${made.id}`, 'PATCH', { labels: ['x', 'y'] }), 'patch labels');
  assert.deepEqual(labelsOf(show(made.id)), ['x', 'y'], 'labels replaced');
  await ok2xx(await send(`/${made.id}`, 'PATCH', { labels: [] }), 'clear labels');
  assert.deepEqual(labelsOf(show(made.id)), [], 'labels cleared');
  await ok2xx(await send(`/${made.id}`, 'PATCH', { parent: '' }), 'detach parent');
  b = show(made.id);
  assert.ok(!b.parent, `no parent after detach: ${b.parent}`);
  assert.deepEqual(parentOf(b), [], 'no parent-child edge after detach');

  // Status: in_progress, close with a reason, reopen; a patch carrying closed goes through close.
  const flow = (await ok2xx(await send('', 'POST', { title: 'flow' }), 'create flow')).id;
  await ok2xx(await send(`/${flow}/status`, 'POST', { status: 'in_progress' }), 'in_progress');
  assert.equal(show(flow).status, 'in_progress');
  await ok2xx(await send(`/${flow}/status`, 'POST', { status: 'closed', reason: 'all done' }), 'close');
  assert.equal(show(flow).status, 'closed');
  assert.equal(show(flow).close_reason, 'all done');
  await ok2xx(await send(`/${flow}/status`, 'POST', { status: 'open' }), 'reopen');
  b = show(flow);
  assert.equal(b.status, 'open');
  assert.ok(!b.closed_at, `closed_at cleared on reopen: ${b.closed_at}`);
  await ok2xx(await send(`/${flow}`, 'PATCH', { status: 'closed' }), 'patch closed');
  assert.equal(show(flow).status, 'closed', 'a patch with status closed closes the bead');

  // br's own refusal on a blocked bead is shown, and nothing changes.
  const blocked = (await ok2xx(await send('', 'POST', { title: 'blocked bead' }), 'create blocked')).id;
  wbr(['dep', 'add', blocked, wblocker, '-t', 'blocks']);
  for (const status of ['in_progress', 'closed']) {
    const r = await send(`/${blocked}/status`, 'POST', { status });
    const body = await r.json();
    assert.equal(r.status, 400, `blocked ${status} answers 400: ${JSON.stringify(body)}`);
    assert.ok(body.error.includes(wblocker), `blocked ${status} message names the blocker: ${body.error}`);
    assert.equal(show(blocked).status, 'open', `blocked ${status} left the status alone`);
  }

  // Comment, dependencies, label removal, archive.
  await ok2xx(await send(`/${flow}/comments`, 'POST', { text: 'from the ui' }), 'comment');
  const comment = show(flow).comments.find((c) => c.text === 'from the ui');
  assert.ok(comment, 'comment is in br show');
  assert.equal(comment.author, actor, 'comment author is the configured actor');
  await ok2xx(await send(`/${flow}/deps`, 'POST', { depends_on_id: wblocker, type: 'blocks' }), 'add dep');
  assert.ok(show(flow).dependencies.some((d) => d.dependency_type === 'blocks' && d.id === wblocker), 'blocks edge visible');
  await ok2xx(await send(`/${flow}/deps`, 'DELETE', { depends_on_id: wblocker }), 'remove dep');
  assert.ok(!(show(flow).dependencies ?? []).some((d) => d.id === wblocker), 'edge gone after removal');
  const tracks = await send(`/${flow}/deps`, 'POST', { depends_on_id: wblocker, type: 'tracks' });
  const tracksBody = await tracks.json();
  assert.equal(tracks.status, 400, `tracks is refused: ${JSON.stringify(tracksBody)}`);
  assert.ok(tracksBody.error.length > 0, 'the refusal carries br\'s message');

  const lab = (await ok2xx(await send('', 'POST', { title: 'labelled', labels: ['keep', 'drop', 'human'] }), 'create labelled')).id;
  await ok2xx(await send(`/${lab}/human`, 'POST', { action: 'respond', text: 'the answer' }), 'respond');
  b = show(lab);
  assert.equal(b.status, 'open', 'respond leaves the bead open');
  assert.ok(b.comments.some((c) => c.text === 'the answer'), 'respond added the comment');
  assert.deepEqual(labelsOf(b), ['drop', 'keep'], 'respond removed only human');
  const lab2 = (await ok2xx(await send('', 'POST', { title: 'dismissed', labels: ['human'] }), 'create human')).id;
  await ok2xx(await send(`/${lab2}/human`, 'POST', { action: 'dismiss' }), 'dismiss');
  assert.deepEqual(labelsOf(show(lab2)), [], 'dismiss removed the label');
  await ok2xx(await send(`/${lab}/archive`, 'POST'), 'archive');
  b = show(lab);
  assert.equal(b.status, 'closed');
  assert.ok(labelsOf(b).includes('archived') && labelsOf(b).includes('keep'), `archived label added, others kept: ${labelsOf(b)}`);

  // Archive is offered on cards that are already done; br refuses to close a closed bead.
  const done = (await ok2xx(await send('', 'POST', { title: 'already done' }), 'create done')).id;
  await ok2xx(await send(`/${done}/status`, 'POST', { status: 'closed', reason: 'finished earlier' }), 'close before archive');
  await ok2xx(await send(`/${done}/archive`, 'POST'), 'archive of a closed bead');
  b = show(done);
  assert.equal(b.status, 'closed');
  assert.equal(b.close_reason, 'finished earlier', 'archiving a closed bead keeps its close reason');
  assert.ok(labelsOf(b).includes('archived'), 'a closed bead can be archived');

  // Text that starts with a hyphen is ordinary: a markdown bullet, a rule, a title quoting a flag.
  // br takes a bare argument like that for an option, so each must reach it as a value.
  const dash = await ok2xx(await send('', 'POST', { title: '-v flag is ignored', description: '- first\n- second' }), 'create with a hyphen title');
  b = show(dash.id);
  assert.equal(b.title, '-v flag is ignored', 'a title starting with a hyphen is stored as typed');
  assert.equal(b.description, '- first\n- second', 'a bullet-list description is stored as typed');
  await ok2xx(await send(`/${dash.id}`, 'PATCH', { title: '--force is not a title option', description: '--- rule' }), 'update with hyphen text');
  b = show(dash.id);
  assert.deepEqual([b.title, b.description], ['--force is not a title option', '--- rule']);
  await ok2xx(await send(`/${dash.id}/comments`, 'POST', { text: '- bullet one\n- bullet two' }), 'comment with a bullet list');
  assert.ok(show(dash.id).comments.some((c) => c.text === '- bullet one\n- bullet two'), 'a bullet-list comment is stored as typed');
  await ok2xx(await send(`/${dash.id}/status`, 'POST', { status: 'closed', reason: '- superseded' }), 'close with a hyphen reason');
  assert.equal(show(dash.id).close_reason, '- superseded', 'a reason starting with a hyphen is stored as typed');

  // Delete: gone from the list, tombstone in the export.
  const gone = (await ok2xx(await send('', 'POST', { title: 'to delete' }), 'create doomed')).id;
  await ok2xx(await send(`/${gone}`, 'DELETE'), 'delete');
  const wlist = await (await fetch(`${wapi}/beads`)).json();
  assert.ok(!wlist.beads.some((x) => x.id === gone), 'deleted bead is not listed');
  const row = fs.readFileSync(path.join(writeDir, '.beads', 'issues.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === gone);
  assert.equal(row?.status, 'tombstone', 'jsonl row is a tombstone');

  // Every event on a bead created, edited and closed through the UI carries the actor.
  const audited = (await ok2xx(await send('', 'POST', { title: 'audited' }), 'create audited')).id;
  await ok2xx(await send(`/${audited}`, 'PATCH', { title: 'audited again' }), 'edit audited');
  await ok2xx(await send(`/${audited}/status`, 'POST', { status: 'closed', reason: 'fin' }), 'close audited');
  const log = JSON.parse(wbr(['audit', 'log', audited, '--json']));
  const events = log.events ?? [];
  assert.ok(events.length >= 3, `audit log has create, edit and close events: ${JSON.stringify(log)}`);
  assert.ok(events.every((e) => e.actor === actor), `every event is by the actor: ${events.map((e) => e.actor)}`);
} finally {
  await fetch(`${base}/api/config`, { method: 'PUT', headers: json, body: JSON.stringify({ humanActor: configBefore.humanActor }) });
  if (writeProjectId) await fetch(`${base}/api/projects/${writeProjectId}`, { method: 'DELETE' });
  if (writeDir) fs.rmSync(writeDir, { recursive: true, force: true });
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('PASS br store: list, detail, 404, doctor, writes with actor, refused gate and change stream on a br tracker');
