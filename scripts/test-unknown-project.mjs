// Isolated server only. Verifies that the order route (GET/PUT) and the per-project
// change stream refuse unknown project ids (and the literal @all) with 404 unknown_project
// without allocating watchers or timers or mutating config.orders, while demo, a registered
// project whose .beads folder was removed, and a healthy br project keep working.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated app server');
const BR = process.env.BR_BIN || 'br';
try {
  execFileSync(BR, ['--version'], { stdio: 'ignore' });
} catch {
  console.log('SKIP unknown project: br is not installed');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonHeaders = { 'Content-Type': 'application/json' };
const editingHeaders = {
  'Content-Type': 'application/json',
  Cookie: 'scotty-viewer-mode=editing',
};
const unknownIds = ['no-such-project', '@all'];

// ---------------------------------------------------------------- static & unit checks

// 1. lib/require-project.ts must not import anything from lib/store.ts.
const requireProjectUrl = new URL('../lib/require-project.ts', import.meta.url);
const requireProjectSrc = fs.readFileSync(requireProjectUrl, 'utf8');
{
  const sf = ts.createSourceFile('require-project.ts', requireProjectSrc, ts.ScriptTarget.ES2022, true);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expr) && expr.text === 'require')) {
        specifiers.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const bad = specifiers.filter((s) => /(?:^|\/)store(?:\.ts)?$/.test(s));
  assert.deepEqual(bad, [], `lib/require-project.ts must not import from lib/store.ts: ${JSON.stringify(bad)}`);
}

// 2. The stream route must refuse unknown ids before creating a watcher, heartbeat, or SSE registration.
{
  class FakeConfigError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ConfigError';
      this.code = code;
    }
  }
  const fakeDemo = { id: 'demo', name: 'Demo', path: null };
  const fakeConfig = {
    ConfigError: FakeConfigError,
    DEMO_PROJECT: fakeDemo,
    getProject: (id) => (id === 'demo' ? fakeDemo : undefined),
  };

  const transpile = (relPath) =>
    ts.transpileModule(fs.readFileSync(new URL(relPath, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

  const rpExports = {};
  vm.runInNewContext(transpile('../lib/require-project.ts'), {
    exports: rpExports,
    require: (id) => {
      if (id === 'server-only') return {};
      if (id === './config') return fakeConfig;
      if (/(?:^|\/)store(?:\.ts)?$/.test(id)) throw new Error('require-project must not require store');
      return require(id);
    },
  });

  let watcherCalls = 0;
  let intervalCalls = 0;
  let registryCalls = 0;
  const streamExports = {};
  vm.runInNewContext(transpile('../app/api/p/[projectId]/beads/stream/route.ts'), {
    exports: streamExports,
    TextEncoder,
    ReadableStream,
    Response,
    setInterval: () => {
      intervalCalls += 1;
      return 0;
    },
    clearInterval: () => {},
    require: (id) => {
      if (id === '@/lib/beads-watch') {
        return {
          subscribeBeadsChange: () => {
            watcherCalls += 1;
            return () => {};
          },
        };
      }
      if (id === '@/lib/sse-registry') {
        return {
          registerSseStream: () => {
            registryCalls += 1;
            return () => {};
          },
        };
      }
      if (id === '@/lib/require-project') return rpExports;
      if (id === '@/lib/api') {
        return {
          fail: (err) => {
            if (err instanceof FakeConfigError) {
              const status = err.code === 'unknown_project' ? 404 : 400;
              return Response.json({ error: err.message, code: err.code }, { status });
            }
            return Response.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
          },
        };
      }
      return require(id);
    },
  });

  for (const id of unknownIds) {
    const req = new Request(`http://127.0.0.1/api/p/${id}/beads/stream`);
    const res = await streamExports.GET(req, { params: Promise.resolve({ projectId: id }) });
    assert.equal(res.status, 404, `unit stream GET for ${id} answers 404`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/i, `unit stream GET for ${id} is JSON`);
    const body = await res.json();
    assert.equal(body.code, 'unknown_project', `unit stream GET for ${id} code`);
  }
  assert.equal(watcherCalls, 0, 'refused stream requests must not subscribe to file watchers');
  assert.equal(intervalCalls, 0, 'refused stream requests must not create a heartbeat interval');
  assert.equal(registryCalls, 0, 'refused stream requests must not register in SSE registry');
}

// ---------------------------------------------------------------- server helpers

function serverPid() {
  const port = new URL(base).port;
  const m = /pid=(\d+)/.exec(execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }));
  assert.ok(m, `no process listens on port ${port}`);
  return Number(m[1]);
}

function inotifyWatches(pid) {
  let n = 0;
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      n += (fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^inotify wd:/gm) ?? []).length;
    } catch {
      /* fd closed meanwhile */
    }
  }
  return n;
}

async function openAndVerifySse(url, label) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    assert.equal(res.status, 200, `${label}: expected 200, got ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/i, `${label}: expected text/event-stream`);
    const reader = res.body.getReader();
    const { done, value } = await reader.read();
    assert.equal(done, false, `${label}: stream ended before sending initial comment`);
    const chunk = new TextDecoder().decode(value);
    assert.ok(chunk.includes(': connected'), `${label}: expected ': connected', got ${JSON.stringify(chunk)}`);
    abort.abort();
    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

const dirs = [];
const registered = [];
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const brIn = (cwd, args) => execFileSync(BR, args, { cwd, encoding: 'utf8' });
const register = async (dir) => {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ path: dir }),
  });
  assert.equal(res.status, 201, `register ${dir}: ${await res.clone().text()}`);
  const id = (await res.json()).id;
  registered.push(id);
  return id;
};

// ---------------------------------------------------------------- server tests

try {
  // 1 & 2. Order GET and PUT refuse unregistered id and @all, without mutating config.orders.
  const configBefore = await (await fetch(`${base}/api/config`)).json();
  for (const id of unknownIds) {
    const getRes = await fetch(`${base}/api/p/${id}/order`);
    assert.equal(getRes.status, 404, `order GET for ${id} answers 404`);
    assert.match(getRes.headers.get('content-type') ?? '', /application\/json/i, `order GET for ${id} is JSON`);
    const getBody = await getRes.json();
    assert.equal(getBody.code, 'unknown_project', `order GET for ${id} code`);
    assert.equal(getBody.error, `Unknown project: ${id}`, `order GET for ${id} message`);

    const putRes = await fetch(`${base}/api/p/${id}/order`, {
      method: 'PUT',
      headers: editingHeaders,
      body: JSON.stringify({ columnId: 'open', ids: ['x-1'] }),
    });
    assert.equal(putRes.status, 404, `order PUT for ${id} answers 404`);
    assert.match(putRes.headers.get('content-type') ?? '', /application\/json/i, `order PUT for ${id} is JSON`);
    const putBody = await putRes.json();
    assert.equal(putBody.code, 'unknown_project', `order PUT for ${id} code`);
    assert.equal(putBody.error, `Unknown project: ${id}`, `order PUT for ${id} message`);

    const configAfter = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(configAfter.orders, configBefore.orders, `config.orders unchanged after refused PUT for ${id}`);
    assert.equal(Object.hasOwn(configAfter.orders, id), false, `config.orders has no key for ${id}`);
  }

  // 3 & 4. Stream refuses unregistered id and @all with 404 JSON and ends; 20 refusals add no watches.
  const pid = serverPid();
  const baseline = inotifyWatches(pid);

  for (const id of unknownIds) {
    const res = await fetch(`${base}/api/p/${id}/beads/stream`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 404, `stream GET for ${id} answers 404`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/i, `stream GET for ${id} is JSON`);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.code, 'unknown_project', `stream GET for ${id} code`);
    assert.equal(body.error, `Unknown project: ${id}`, `stream GET for ${id} message`);
  }

  for (let i = 0; i < 20; i++) {
    const id = i % 2 === 0 ? `no-such-project-${i}` : '@all';
    const res = await fetch(`${base}/api/p/${id}/beads/stream`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 404, `refused stream #${i} (${id}) answers 404`);
    const body = JSON.parse(await res.text());
    assert.equal(body.code, 'unknown_project', `refused stream #${i} (${id}) code`);
  }
  assert.equal(inotifyWatches(pid), baseline, 'twenty refused stream requests do not change server watch count');

  // 5. The demo project still gets 200 from order GET and a 200 event stream.
  {
    const orderRes = await fetch(`${base}/api/p/demo/order`);
    assert.equal(orderRes.status, 200, `demo order GET answers 200: ${await orderRes.clone().text()}`);
    const orderData = await orderRes.json();
    assert.equal(typeof orderData.orders, 'object', 'demo order GET returns orders object');
    await openAndVerifySse(`${base}/api/p/demo/beads/stream`, 'demo stream');
  }

  // 6. A registered project whose .beads directory is removed still gets 200 from order GET and stream.
  {
    const brokenDir = tmp('scotty-unknown-broken-');
    execFileSync('git', ['init', '-q'], { cwd: brokenDir });
    brIn(brokenDir, ['init', '--prefix', 'bk']);
    const brokenId = await register(brokenDir);
    fs.rmSync(path.join(brokenDir, '.beads'), { recursive: true, force: true });

    const orderRes = await fetch(`${base}/api/p/${brokenId}/order`);
    assert.equal(orderRes.status, 200, `broken project order GET answers 200: ${await orderRes.clone().text()}`);
    const orderData = await orderRes.json();
    assert.equal(typeof orderData.orders, 'object', 'broken project order GET returns orders object');
    await openAndVerifySse(`${base}/api/p/${brokenId}/beads/stream`, 'broken project stream');
  }

  // 7. A healthy registered br project stores & reads back order and delivers a stream change event on API status write.
  {
    const okDir = tmp('scotty-unknown-ok-');
    execFileSync('git', ['init', '-q'], { cwd: okDir });
    brIn(okDir, ['init', '--prefix', 'uk']);
    const beadId = JSON.parse(brIn(okDir, ['create', 'stream test bead', '--json'])).id;
    const okId = await register(okDir);

    const putRes = await fetch(`${base}/api/p/${okId}/order`, {
      method: 'PUT',
      headers: editingHeaders,
      body: JSON.stringify({ columnId: 'open', ids: [beadId] }),
    });
    assert.equal(putRes.status, 200, `registered project order PUT: ${await putRes.clone().text()}`);
    assert.deepEqual((await putRes.json()).orders.open, [beadId], 'order PUT returns stored column order');

    const getRes = await fetch(`${base}/api/p/${okId}/order`);
    assert.equal(getRes.status, 200, `registered project order GET: ${await getRes.clone().text()}`);
    assert.deepEqual((await getRes.json()).orders.open, [beadId], 'order GET reads back stored column order');

    const abort = new AbortController();
    const streamRes = await fetch(`${base}/api/p/${okId}/beads/stream`, { signal: abort.signal });
    assert.equal(streamRes.status, 200, `registered project stream: ${streamRes.status}`);
    assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/i);
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(decoder.decode(first.value).includes(': connected'));

    let changes = 0;
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          changes += decoder.decode(value).split('event: change').length - 1;
        }
      } catch {
        /* aborted */
      }
    })();

    await sleep(500);
    changes = 0;

    const statusRes = await fetch(`${base}/api/p/${okId}/beads/${beadId}/status`, {
      method: 'POST',
      headers: editingHeaders,
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.equal(statusRes.status, 200, `status write through API: ${await statusRes.clone().text()}`);

    const deadline = Date.now() + 5000;
    while (changes === 0 && Date.now() < deadline) await sleep(100);
    assert.ok(changes > 0, 'stream delivers a change event within 5 seconds of a status write through the API');

    abort.abort();
    await pump;
  }

  console.log('PASS unknown project: order GET/PUT, stream refusals, watch count, demo, broken tracker, and br project');
} finally {
  for (const id of registered) {
    await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}
