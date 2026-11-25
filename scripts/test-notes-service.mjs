// Pure unit tests for lib/notes-service.ts, the hub's client for the notes
// service, against stub servers on 127.0.0.1 port 0. No build, no app server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

/** The longest any answer may take; the client's own timeout is 2 s. */
const ANSWER_LIMIT_MS = 3000;

// The real config module over a throwaway config directory, so the client reads
// its address the way the app stores it. An empty registry keeps the module
// from registering the directory this script runs in as a project.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-notes-'));
process.env.XDG_CONFIG_HOME = scratch;
fs.mkdirSync(path.join(scratch, 'houston'));
fs.writeFileSync(path.join(scratch, 'houston', 'config.json'), JSON.stringify({ projects: [] }));

const loaded = {};
function load(name) {
  if (loaded[name]) return loaded[name];
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const req = (id) => {
    if (id === 'server-only') return {};
    if (id.startsWith('./')) return load(id.slice(2));
    return require(id);
  };
  const globals = { exports, require: req, structuredClone, Date, process, console, URL, AbortSignal, fetch };
  vm.runInNewContext(code, globals, { filename: name });
  return (loaded[name] = exports);
}

const { saveConfig } = load('config');
const { fetchNotesRefs, searchNotes } = load('notes-service');

/** Values built inside the vm context carry its prototypes; compare plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const note = (id, kind) => ({ id, title: `Title ${id}`, path: `work/${id}.md`, kind, tags: ['phase-3'] });
const REFS = {
  notes: [
    { ...note('n1', 'plano'), matchedRefs: ['STRY00000001', 'hou-1'] },
    { ...note('n2', 'implementacao'), matchedRefs: ['hou-1'] },
  ],
  linked: [note('n3', 'evidencia'), { ...note('n4', 'nota'), tags: [] }],
  linkedOmitted: 3,
};
const EMPTY_REFS = { notes: [], linked: [], linkedOmitted: 0 };
const SEARCH = {
  hits: [{ ...note('n1', 'plano'), snippet: 'the \u0002rollout\u0003 plan' }],
  total: 41,
  limit: 20,
  offset: 40,
};
const EMPTY_SEARCH = { hits: [], total: 0, limit: 20, offset: 0 };

const reply = (status, body, headers = {}) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const neverAnswer = () => {};
const neverFinish = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{"notes":[');
};

const stubs = [];
async function startStub(handler) {
  const stub = { handler, requests: [] };
  stub.server = http.createServer((req, res) => {
    stub.requests.push({ method: req.method, url: new URL(req.url, 'http://stub.invalid'), headers: req.headers });
    stub.handler(req, res);
  });
  await new Promise((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
  stub.port = stub.server.address().port;
  stub.url = `http://127.0.0.1:${stub.port}/`;
  stubs.push(stub);
  return stub;
}
async function stopStub(stub) {
  if (!stub.server.listening) return;
  stub.server.closeAllConnections();
  await new Promise((resolve) => stub.server.close(resolve));
}

/** An incoming request to a Houston listening where no stub can be. */
const incoming = (init = {}, url = 'http://127.0.0.1:1/api/notes/search') => new Request(url, init);

const callRefs = (request = incoming()) => fetchNotesRefs(request, { ids: ['hou-1'] });
const callSearch = (request = incoming()) => searchNotes(request, { q: 'rollout' });
const BOTH = [['refs', callRefs], ['search', callSearch]];

/** Fails, instead of hanging the script, when a client has lost its timeout. */
async function within(promise, ms, label) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectUnavailable(call, label, reason) {
  const started = Date.now();
  const result = plain(await within(call(), ANSWER_LIMIT_MS, label));
  const elapsed = Date.now() - started;
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason', 'status'], `${label}: carries no answer`);
  assert.equal(result.ok, false, `${label}: is not ok`);
  assert.equal(result.status, 'unavailable', `${label}: is unavailable`);
  assert.match(result.reason, reason, `${label}: names its cause`);
  assert.ok(elapsed < ANSWER_LIMIT_MS, `${label}: answered within 3 s (took ${elapsed} ms)`);
  return elapsed;
}

try {
  // ── Unconfigured ───────────────────────────────────────────────────────
  for (const [name, call] of BOTH) {
    const result = plain(await within(call(), ANSWER_LIMIT_MS, `unconfigured ${name}`));
    assert.equal(result.ok, false, `unconfigured ${name}: is not ok`);
    assert.equal(result.status, 'unconfigured', `unconfigured ${name}: says so`);
    assert.ok(result.reason.length > 0, `unconfigured ${name}: carries a reason`);
  }

  const stub = await startStub(reply(200, REFS));
  saveConfig({ notesServiceUrl: stub.url });

  // ── A refs call ────────────────────────────────────────────────────────
  {
    const request = incoming({ headers: { cookie: 'scotty-viewer-mode=editing', origin: 'http://127.0.0.1:1' } });
    const ids = ['hou-1', 'STRY00000001', 'a&b #c'];
    const result = await within(fetchNotesRefs(request, { ids, kind: 'plano', hop: 1 }), ANSWER_LIMIT_MS, 'refs');
    assert.deepEqual(plain(result), { ok: true, answer: REFS }, 'refs: the pinned answer comes back whole');
    assert.equal(stub.requests.length, 1, 'refs: one request');
    const [seen] = stub.requests;
    assert.equal(seen.method, 'GET', 'refs: a GET');
    assert.equal(seen.url.pathname, '/api/notes/refs', 'refs: the refs route');
    assert.deepEqual(
      [...seen.url.searchParams],
      [['ids', 'hou-1,STRY00000001,a&b #c'], ['kind', 'plano'], ['hop', '1']],
      'refs: identifiers as one list, kind and hop',
    );
    assert.equal(seen.headers['cache-control'], 'no-cache', 'refs: cache no-store reaches the wire');
    // The service's guard refuses anything that looks like a browser, and
    // nothing of the incoming request is the service's business.
    assert.equal(seen.headers.origin, undefined, 'refs: no Origin header');
    assert.equal(seen.headers['sec-fetch-site'], undefined, 'refs: no Sec-Fetch-Site header');
    assert.equal(seen.headers.cookie, undefined, 'refs: no cookie forwarded');

    stub.handler = reply(200, EMPTY_REFS);
    stub.requests.length = 0;
    assert.deepEqual(plain(await callRefs()), { ok: true, answer: EMPTY_REFS }, 'refs: empty lists are an answer');
    assert.deepEqual([...stub.requests[0].url.searchParams], [['ids', 'hou-1']], 'refs: absent filters are not sent');
    await fetchNotesRefs(incoming(), { ids: ['hou-1'], hop: 0 });
    assert.equal(stub.requests[1].url.searchParams.get('hop'), '0', 'refs: hop 0 is sent when asked for');
  }

  // ── A search call ──────────────────────────────────────────────────────
  {
    stub.handler = reply(200, SEARCH);
    stub.requests.length = 0;
    const query = { q: 'phase 3 & #notes', tag: 'ops', folder: 'ops/2026_q4', kind: 'evidencia', limit: 20, offset: 0 };
    const result = await within(searchNotes(incoming(), { ...query, extra: 'x' }), ANSWER_LIMIT_MS, 'search');
    assert.deepEqual(plain(result), { ok: true, answer: SEARCH }, 'search: the pinned answer comes back whole');
    assert.equal(stub.requests.length, 1, 'search: one request');
    const [seen] = stub.requests;
    assert.equal(seen.url.pathname, '/api/search', 'search: the search route');
    assert.deepEqual(
      Object.fromEntries(seen.url.searchParams),
      { q: 'phase 3 & #notes', tag: 'ops', folder: 'ops/2026_q4', kind: 'evidencia', limit: '20', offset: '0' },
      'search: its six parameters and no other',
    );
    assert.equal(seen.headers['cache-control'], 'no-cache', 'search: cache no-store reaches the wire');

    stub.handler = reply(200, EMPTY_SEARCH);
    stub.requests.length = 0;
    assert.deepEqual(plain(await callSearch()), { ok: true, answer: EMPTY_SEARCH }, 'search: no hit is an answer');
    assert.deepEqual([...stub.requests[0].url.searchParams], [['q', 'rollout']], 'search: absent filters are not sent');
  }

  // A field added to the answer later is dropped, not a failure.
  {
    stub.handler = reply(200, { ...EMPTY_REFS, added: true });
    assert.deepEqual(plain(await callRefs()), { ok: true, answer: EMPTY_REFS }, 'an added field is dropped');
  }

  // ── Houston's own address ──────────────────────────────────────────────
  {
    stub.handler = reply(200, REFS);
    stub.requests.length = 0;
    const { port } = stub;
    const own = [
      ['same origin as the request URL', stub.url, incoming({}, `${stub.url}api/notes/search`)],
      ['named by the Host header', stub.url, incoming({ headers: { host: `127.0.0.1:${port}` } })],
      ['request URL on the localhost alias', stub.url, incoming({}, `http://localhost:${port}/search`)],
      ['configured as localhost', `http://localhost:${port}/`, incoming({}, `${stub.url}search`)],
      ['configured as [::1]', `http://[::1]:${port}/`, incoming({}, `${stub.url}search`)],
    ];
    for (const [label, configured, request] of own) {
      saveConfig({ notesServiceUrl: configured });
      for (const [name, call] of BOTH) {
        await expectUnavailable(() => call(request), `own address, ${label}, ${name}`, /Houston itself/);
      }
    }
    assert.equal(stub.requests.length, 0, 'own address: refused before any request reaches the stub');
    saveConfig({ notesServiceUrl: stub.url });
  }

  // ── A 200 answer of the wrong shape ────────────────────────────────────
  {
    const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
    const refsNote = REFS.notes[0];
    const linkedNote = REFS.linked[0];
    const hit = SEARCH.hits[0];
    const wrongRefs = [
      ['an empty object', {}],
      ['null', null],
      ['a list', []],
      ['the search answer', SEARCH],
      ...Object.keys(REFS).map((key) => [`no ${key}`, without(REFS, key)]),
      ['a null notes list', { ...REFS, notes: null }],
      ['a null linked list', { ...REFS, linked: null }],
      ['a text count', { ...REFS, linkedOmitted: '3' }],
      ['a negative count', { ...REFS, linkedOmitted: -1 }],
      ['a fractional count', { ...REFS, linkedOmitted: 1.5 }],
      ...Object.keys(refsNote).map((key) => [`a note with no ${key}`, { ...REFS, notes: [without(refsNote, key)] }]),
      ...Object.keys(linkedNote).map((key) => [`a linked note with no ${key}`, { ...REFS, linked: [without(linkedNote, key)] }]),
      ['a numeric id', { ...REFS, notes: [{ ...refsNote, id: 1 }] }],
      ['an empty kind', { ...REFS, notes: [{ ...refsNote, kind: '' }] }],
      ['an unknown kind', { ...REFS, linked: [{ ...linkedNote, kind: 'other' }] }],
      ['null tags', { ...REFS, notes: [{ ...refsNote, tags: null }] }],
      ['a numeric tag', { ...REFS, notes: [{ ...refsNote, tags: [1] }] }],
      ['null matchedRefs', { ...REFS, notes: [{ ...refsNote, matchedRefs: null }] }],
    ];
    const wrongSearch = [
      ['an empty object', {}],
      ['null', null],
      ['the refs answer', REFS],
      ...Object.keys(SEARCH).map((key) => [`no ${key}`, without(SEARCH, key)]),
      ['a null hit list', { ...SEARCH, hits: null }],
      ['a text total', { ...SEARCH, total: '41' }],
      ['a negative offset', { ...SEARCH, offset: -1 }],
      ['a fractional limit', { ...SEARCH, limit: 2.5 }],
      ...Object.keys(hit).map((key) => [`a hit with no ${key}`, { ...SEARCH, hits: [without(hit, key)] }]),
      ['an unknown kind', { ...SEARCH, hits: [{ ...hit, kind: 'other' }] }],
    ];
    for (const [call, table, name] of [[callRefs, wrongRefs, 'refs'], [callSearch, wrongSearch, 'search']]) {
      for (const [label, body] of table) {
        stub.handler = reply(200, body);
        await expectUnavailable(() => call(), `${name} answered ${label}`, /unexpected shape/);
      }
    }
  }

  // ── Invalid JSON, a non-2xx status, a redirect ─────────────────────────
  for (const [name, call] of BOTH) {
    const valid = name === 'refs' ? REFS : SEARCH;
    for (const body of ['{"notes": [', '<html>not json</html>', '']) {
      stub.handler = reply(200, body);
      await expectUnavailable(() => call(), `${name} answered ${JSON.stringify(body)}`, /did not answer JSON/);
    }
    // The bodies are well shaped, so only the status can refuse them.
    for (const status of [500, 404, 403]) {
      stub.handler = reply(status, valid);
      await expectUnavailable(() => call(), `${name} answered ${status}`, new RegExp(`HTTP ${status}`));
    }
    const elsewhere = await startStub(reply(200, valid));
    stub.handler = reply(302, '', { Location: `${elsewhere.url}api` });
    await expectUnavailable(() => call(), `${name} redirected`, /HTTP 302/);
    assert.equal(elsewhere.requests.length, 0, `${name} redirected: the target saw no request`);
  }

  // ── A stopped service ──────────────────────────────────────────────────
  {
    const stopped = await startStub(reply(200, REFS));
    await stopStub(stopped);
    saveConfig({ notesServiceUrl: stopped.url });
    for (const [name, call] of BOTH) {
      await expectUnavailable(() => call(), `${name} with the service stopped`, /could not be reached/);
    }
    saveConfig({ notesServiceUrl: stub.url });
  }

  // ── A hanging service, before the headers and in the middle of the body ─
  for (const [label, handler] of [['no answer', neverAnswer], ['half a body', neverFinish]]) {
    stub.handler = handler;
    const waits = await Promise.all(
      BOTH.map(([name, call]) => expectUnavailable(() => call(), `${name} hanging with ${label}`, /in time/)),
    );
    for (const elapsed of waits) {
      assert.ok(elapsed >= 1900, `hanging with ${label}: waited the 2 s timeout (took ${elapsed} ms)`);
    }
  }

  // ── Aborted with its incoming request ──────────────────────────────────
  for (const [name, call] of BOTH) {
    for (const [label, handler] of [['no answer', neverAnswer], ['half a body', neverFinish]]) {
      const controller = new AbortController();
      const request = incoming({ signal: controller.signal });
      stub.requests.length = 0;
      let abortedAt = 0;
      let connection;
      stub.handler = (req, res) => {
        connection = req.socket;
        handler(req, res);
        setTimeout(() => {
          abortedAt = Date.now();
          controller.abort();
        }, 100);
      };
      await expectUnavailable(() => call(request), `${name} aborted with ${label}`, /cancelled/);
      assert.ok(abortedAt > 0, `${name} aborted with ${label}: the request reached the stub first`);
      const lag = Date.now() - abortedAt;
      assert.ok(lag < 1000, `${name} aborted with ${label}: gave up with its request (took ${lag} ms)`);
      for (let waited = 0; !connection.destroyed && waited < 1000; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(connection.destroyed, `${name} aborted with ${label}: the connection was closed`);
    }

    stub.handler = reply(200, REFS);
    stub.requests.length = 0;
    const gone = incoming({ signal: AbortSignal.abort() });
    await expectUnavailable(() => call(gone), `${name} already aborted`, /cancelled/);
    assert.equal(stub.requests.length, 0, `${name} already aborted: nothing was sent`);
  }

  // ── Cleared again ──────────────────────────────────────────────────────
  saveConfig({ notesServiceUrl: null });
  assert.equal(plain(await callRefs()).status, 'unconfigured', 'a cleared address is unconfigured again');

  console.log('PASS (unit): notes service client answers, refuses its own address and degrades to unavailable');
} finally {
  for (const stub of stubs) await stopStub(stub);
  fs.rmSync(scratch, { recursive: true, force: true });
}
