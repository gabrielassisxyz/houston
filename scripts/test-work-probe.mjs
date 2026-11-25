// Probe of the work dashboard's reachability from Houston's server side.
//
// Pure half: `isSelfTarget` over every combination of `request.url` and
// `Host` a test server listening on one address cannot reach. Server half
// (under SCOTTY_TEST_URL): drives POST /api/work/probe against test-owned
// HTTP servers on 127.0.0.1 port 0.
import assert from 'node:assert/strict';
import http from 'node:http';
import { isSelfTarget } from '../lib/work-probe.ts';

// ── Pure half ─────────────────────────────────────────────────────────────
const p = 4321;
const target = `http://127.0.0.1:${p}/`;

assert.equal(
  isSelfTarget(target, `http://127.0.0.1:${p}/api/work/probe`, null),
  true,
  'same origin, no Host: self',
);
assert.equal(
  isSelfTarget(target, `http://127.0.0.1:${p}/api/work/probe`, `127.0.0.1:${p}`),
  true,
  'same origin, matching Host: self',
);
assert.equal(
  isSelfTarget(target, `http://0.0.0.0:${p}/api/work/probe`, `127.0.0.1:${p}`),
  true,
  'wildcard 0.0.0.0 request URL, matching Host: self',
);
assert.equal(
  isSelfTarget(target, `http://0.0.0.0:${p}/api/work/probe`, null),
  true,
  'wildcard 0.0.0.0 request URL, no Host: self through the alias branch',
);
assert.equal(
  isSelfTarget(target, `http://[::]:${p}/api/work/probe`, `127.0.0.1:${p}`),
  true,
  'wildcard [::] request URL, matching Host: self',
);
assert.equal(
  isSelfTarget(target, `http://[::]:${p}/api/work/probe`, null),
  true,
  'wildcard [::] request URL, no Host: self through the bracket strip',
);
assert.equal(
  isSelfTarget(target, `http://localhost:${p}/api/work/probe`, `localhost:${p}`),
  true,
  'localhost request URL, localhost Host: self',
);
assert.equal(
  isSelfTarget(target, `http://localhost:${p}/api/work/probe`, `[::1]:${p}`),
  true,
  'localhost request URL, [::1] Host: self through the bracket strip',
);
assert.equal(
  isSelfTarget(target, `http://127.0.0.1:${p + 1}/api/work/probe`, `127.0.0.1:${p}`),
  true,
  'request URL on another port, matching Host: self through the Host candidate alone',
);
assert.equal(
  isSelfTarget('http://127.0.0.1/', 'http://127.0.0.1/', '127.0.0.1:80'),
  true,
  'default port written on one side only: self, ports normalised by the parser',
);
assert.equal(
  isSelfTarget(target, `http://127.0.0.1:${p + 1}/api/work/probe`, `127.0.0.1:${p + 1}`),
  false,
  'another port: not self',
);
assert.equal(
  isSelfTarget(target, `https://127.0.0.1:${p}/api/work/probe`, `127.0.0.1:${p}`),
  false,
  'another scheme: not self',
);
assert.doesNotThrow(
  () => isSelfTarget(target, `http://127.0.0.1:${p + 1}/api/work/probe`, ':::bogus'),
  'malformed Host: no throw',
);
assert.equal(
  isSelfTarget(target, `http://127.0.0.1:${p + 1}/api/work/probe`, ':::bogus'),
  false,
  'malformed Host: not self',
);

console.log('PASS (unit): isSelfTarget over request URL and Host combinations');

// ── Server half ───────────────────────────────────────────────────────────
const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log('SKIP server half: SCOTTY_TEST_URL is not set');
  process.exit(0);
}
const { hostname, port } = new URL(base);
const jsonHeaders = { 'Content-Type': 'application/json' };

function startServer(handler) {
  const srv = http.createServer(handler);
  srv.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function serverUrl(srv) {
  return `http://127.0.0.1:${srv.address().port}/`;
}

async function closeServer(srv) {
  srv.closeAllConnections();
  await new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
}

async function waitFor(cond, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(cond(), `${name}: happened within ${timeoutMs} ms`);
}

async function putConfig(patch) {
  const res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(4000),
  });
  return { status: res.status, body: await res.json() };
}

async function postProbe(headers = {}) {
  return fetch(`${base}/api/work/probe`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(4000),
  });
}

function expectNoStore(res, name) {
  assert.equal(res.headers.get('cache-control'), 'no-store', `${name}: cache-control is no-store`);
}

// A Host header fetch would replace, so the localhost-Host case goes through
// node:http with setHost: false, as scripts/test-request-guard.mjs:44-55 does.
// The 4-second bound the other probe requests carry as an abort signal is a
// socket timeout here.
function postProbeRawHost(hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: hostname,
        port,
        method: 'POST',
        path: '/api/work/probe',
        headers: { Host: hostHeader },
        setHost: false,
        timeout: 4000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('probe request timed out')));
    req.end();
  });
}

const servers = [];
try {
  let counterHits = 0;
  const counter = await startServer((_req, res) => {
    counterHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  servers.push(counter);

  // Guard checks: a counting collector behind the key.
  let put = await putConfig({ workDashboardUrl: serverUrl(counter) });
  assert.equal(put.status, 200, `PUT workDashboardUrl answers 200: ${JSON.stringify(put.body)}`);

  let res = await postProbe();
  assert.equal(res.status, 200, 'POST with no Origin probes');
  assert.deepEqual(await res.json(), { configured: true, reachable: true }, 'POST with no Origin: reachable');
  expectNoStore(res, 'POST with no Origin');
  assert.equal(counterHits, 1, 'POST with no Origin reached the collector once');

  res = await postProbe({ Cookie: 'scotty-viewer-mode=read-only' });
  assert.equal(res.status, 200, 'POST with the read-only cookie still probes');
  assert.deepEqual(await res.json(), { configured: true, reachable: true }, 'read-only cookie: reachable');
  expectNoStore(res, 'read-only cookie POST');

  res = await postProbe({ Origin: 'http://evil.example' });
  assert.equal(res.status, 403, 'POST with a foreign Origin is refused');
  assert.equal(counterHits, 2, 'foreign Origin reached no new collector request');

  res = await fetch(`${base}/api/work/probe`, { method: 'GET', signal: AbortSignal.timeout(4000) });
  assert.equal(res.status, 405, 'GET to the probe route is not implemented');
  await res.arrayBuffer().catch(() => {});
  assert.equal(counterHits, 2, 'GET reached no collector request');

  // Unset key: no outbound request.
  put = await putConfig({ workDashboardUrl: null });
  assert.equal(put.status, 200, 'clearing the key answers 200');
  res = await postProbe();
  assert.equal(res.status, 200, 'unset POST answers 200');
  assert.deepEqual(await res.json(), { configured: false }, 'unset: configured false');
  expectNoStore(res, 'unset POST');

  // Houston's own address: exact body, without waiting for the timeout.
  put = await putConfig({ workDashboardUrl: base });
  assert.equal(put.status, 200, 'self address is a storable 127.0.0.1 URL');
  let t0 = Date.now();
  res = await postProbe();
  let elapsed = Date.now() - t0;
  assert.equal(res.status, 200, 'self POST answers 200');
  assert.deepEqual(
    await res.json(),
    { configured: true, reachable: false, reason: 'self' },
    'SCOTTY_TEST_URL as the key: exactly self, before any self-call',
  );
  expectNoStore(res, 'self POST');
  assert.ok(elapsed < 1500, `self answer did not wait for the timeout (took ${elapsed} ms)`);

  put = await putConfig({ workDashboardUrl: `${base}/api/work/probe` });
  assert.equal(put.status, 200, 'probe route address is a storable 127.0.0.1 URL');
  t0 = Date.now();
  res = await postProbe();
  elapsed = Date.now() - t0;
  assert.deepEqual(
    await res.json(),
    { configured: true, reachable: false, reason: 'self' },
    'probe route address as the key: exactly self, never called itself',
  );
  assert.ok(elapsed < 1500, `self-route answer did not wait for the timeout (took ${elapsed} ms)`);

  const raw = await postProbeRawHost(`localhost:${port}`);
  assert.equal(raw.status, 200, 'Host localhost request answers 200');
  assert.deepEqual(
    JSON.parse(raw.body),
    { configured: true, reachable: false, reason: 'self' },
    'Host localhost: exactly self through the route wiring',
  );

  // Statuses: any resolved status is reachable.
  const ok200 = await startServer((_req, res2) => {
    res2.writeHead(200, { 'Content-Type': 'text/plain' });
    res2.end('ok');
  });
  servers.push(ok200);
  const fail500 = await startServer((_req, res2) => {
    res2.writeHead(500, { 'Content-Type': 'text/plain' });
    res2.end('boom');
  });
  servers.push(fail500);
  const empty204 = await startServer((_req, res2) => {
    res2.writeHead(204);
    res2.end();
  });
  servers.push(empty204);

  for (const [srv, name] of [[ok200, '200'], [fail500, '500'], [empty204, '204 no body']]) {
    put = await putConfig({ workDashboardUrl: serverUrl(srv) });
    assert.equal(put.status, 200, `key points at the ${name} fixture`);
    res = await postProbe();
    assert.equal(res.status, 200, `${name} POST answers 200`);
    assert.deepEqual(await res.json(), { configured: true, reachable: true }, `${name}: reachable`);
    expectNoStore(res, `${name} POST`);
  }

  // Redirect: reachable, and never followed.
  let landingHits = 0;
  const landing = await startServer((_req, res2) => {
    landingHits += 1;
    res2.writeHead(200, { 'Content-Type': 'text/plain' });
    res2.end('landed');
  });
  servers.push(landing);
  let redirectHits = 0;
  const landingUrl = serverUrl(landing);
  const redirect = await startServer((_req, res2) => {
    redirectHits += 1;
    res2.writeHead(302, { Location: `${landingUrl}target` });
    res2.end();
  });
  servers.push(redirect);
  put = await putConfig({ workDashboardUrl: serverUrl(redirect) });
  assert.equal(put.status, 200, 'key points at the redirect fixture');
  res = await postProbe();
  assert.deepEqual(await res.json(), { configured: true, reachable: true }, '302: reachable');
  assert.equal(redirectHits, 1, '302: the first server answered once');
  assert.equal(landingHits, 0, '302: the redirect target saw no request');

  // Endless body: reachable promptly, and the fixture sees its socket close.
  let endlessCloseAt = null;
  const endless = await startServer((req, res2) => {
    res2.writeHead(200, { 'Content-Type': 'text/plain' });
    res2.flushHeaders();
    req.socket.on('close', () => {
      if (endlessCloseAt === null) endlessCloseAt = Date.now();
    });
  });
  servers.push(endless);
  put = await putConfig({ workDashboardUrl: serverUrl(endless) });
  assert.equal(put.status, 200, 'key points at the endless-body fixture');
  t0 = Date.now();
  res = await postProbe();
  const resolvedAt = Date.now();
  assert.deepEqual(await res.json(), { configured: true, reachable: true }, 'endless body: reachable');
  assert.ok(resolvedAt - t0 < 1000, `endless body answered promptly (took ${resolvedAt - t0} ms)`);
  await waitFor(() => endlessCloseAt !== null, 1500, 'endless-body socket close');
  assert.ok(
    endlessCloseAt - resolvedAt <= 1000,
    `endless-body socket closed within 1,000 ms (took ${endlessCloseAt - resolvedAt} ms)`,
  );

  // Closed server: unreachable.
  const closed = await startServer((_req, res2) => res2.end('gone'));
  const closedUrl = serverUrl(closed);
  await closeServer(closed);
  put = await putConfig({ workDashboardUrl: closedUrl });
  assert.equal(put.status, 200, 'key points at the closed fixture');
  res = await postProbe();
  assert.equal(res.status, 200, 'closed-server POST answers 200');
  assert.deepEqual(await res.json(), { configured: true, reachable: false }, 'closed server: unreachable');
  expectNoStore(res, 'closed-server POST');

  // Hanging server: unreachable in under 3 seconds, socket closed after the abort.
  const hangingCloses = [];
  const hanging = await startServer((req) => {
    req.socket.on('close', () => hangingCloses.push(Date.now()));
  });
  servers.push(hanging);
  put = await putConfig({ workDashboardUrl: serverUrl(hanging) });
  assert.equal(put.status, 200, 'key points at the hanging fixture');
  const hangingSeen = hangingCloses.length;
  t0 = Date.now();
  res = await postProbe();
  elapsed = Date.now() - t0;
  assert.deepEqual(await res.json(), { configured: true, reachable: false }, 'hanging server: unreachable');
  expectNoStore(res, 'hanging-server POST');
  assert.ok(elapsed < 3000, `hanging server answered in under 3 seconds (took ${elapsed} ms)`);
  await waitFor(() => hangingCloses.length > hangingSeen, 1500, 'hanging socket close after the abort');

  // Client abort: the page's own cancellation closes the fixture socket fast.
  const abortSeen = hangingCloses.length;
  const ctrl = new AbortController();
  const abortAt = Date.now() + 150;
  setTimeout(() => ctrl.abort(), 150);
  try {
    await fetch(`${base}/api/work/probe`, { method: 'POST', headers: {}, signal: ctrl.signal });
  } catch {
    // The test gave up first; the assertion below is on the fixture socket.
  }
  await waitFor(() => hangingCloses.length > abortSeen, 1500, 'hanging socket close after the page gave up');
  const abortCloseLag = hangingCloses[hangingCloses.length - 1] - abortAt;
  assert.ok(
    abortCloseLag < 1000,
    `page cancellation closed the collector socket well inside 1,000 ms (took ${abortCloseLag} ms)`,
  );

  console.log('PASS (server): work probe guards, statuses, redirect, endless body, closed, hanging, page abort');
} finally {
  await putConfig({ workDashboardUrl: null }).catch(() => {});
  for (const srv of servers) {
    try {
      await closeServer(srv);
    } catch {
      // Already closed (the closed-server fixture) or mid-teardown.
    }
  }
}
