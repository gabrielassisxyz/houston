// Browser test for the Relacionadas chain section: drawer and epic view with fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated server started from the current build');

const T = '2026-09-01T00:00:00Z';
const bead = (id, title, extra = {}) => ({
  id, title, description: 'Body', status: 'open', issue_type: 'task', priority: 2,
  labels: [], dependencies: [], comments: [], created_at: T, updated_at: T, ...extra,
});
const epic = (id, title, extra = {}) => bead(id, title, { issue_type: 'epic', ...extra });

const projectBeads = [
  epic('ep-1', 'Epic one', { external_ref: 'STRY00000001' }),
  bead('t-hist', 'Historical task', { external_ref: 'STRY00000002' }),
  bead('t-partial', 'Partial task', { external_ref: 'INC00000001' }),
  bead('t-absent', 'Absent task', { external_ref: 'STRY00000009' }),
  bead('t-unconfirmed', 'Unconfirmed task', { external_ref: 'BUG00000001' }),
  bead('t-baddate', 'Bad date task', { external_ref: 'CHG00000002' }),
  bead('t-empty', 'Empty task'),
  bead('t-error', 'Error task', { external_ref: 'STRY00000003' }),
  bead('t-loading', 'Loading task', { external_ref: 'STRY00000004' }),
  epic('ep:colon', 'Colon epic', { external_ref: 'STRY00000001' }),
];

const alpha = { id: 'alpha', name: 'Alpha App' };
const merged = (b) => ({
  ...b,
  id: `${alpha.id}:${b.id}`,
  local_id: b.id,
  project: alpha,
  dependencies: (b.dependencies ?? []).map((d) => ({
    ...d,
    issue_id: `${alpha.id}:${d.issue_id}`,
    depends_on_id: `${alpha.id}:${d.depends_on_id}`,
  })),
});

const STORY = {
  state: 'found', freshness: 'confirmed', source: 'work_tracker_stories', number: 'STRY00000001',
  title: 'Synthetic story', status: 'Work in progress', sprint: 'sprint-a',
  link: 'https://example.com/rm_story.do?sys_id=31', approvals: [],
};
const approvalHist = {
  number: 'CHG00000001', title: 'Synthetic change', recordType: 'change_request', state: 'Requested',
  link: 'https://example.com/sysapproval_approver.do?sys_id=11',
  freshness: 'historical', lastConfirmedAt: '2026-11-19T12:00:30Z',
};
const HIST = {
  state: 'found', freshness: 'historical', lastConfirmedAt: '2026-11-19T08:00:00Z',
  source: 'incidents', number: 'INC00000001', title: 'Synthetic incident', status: 'Example state',
  link: 'https://example.com/incident.do?sys_id=01', approvals: [approvalHist],
};
const PARTIAL = {
  state: 'found', freshness: 'partial', source: 'work_tracker_stories', number: 'STRY00000002',
  title: 'Partial story', status: 'Open', link: 'https://example.com/rm_story.do?sys_id=32', approvals: [],
};
const ABSENT = {
  state: 'absent',
  approvals: [{
    number: 'CHG00000002', title: 'Synthetic change outside the collected scope',
    recordType: 'change_request', state: 'Requested',
    link: 'https://example.com/sysapproval_approver.do?sys_id=12', freshness: 'confirmed',
  }],
};
const UNCONFIRMED = {
  state: 'unconfirmed', reason: 'ticket sources not collected ok and complete: incidents (error)',
  approvals: [{
    number: 'STRY00000002', title: 'Synthetic story awaiting approval', recordType: 'rm_story',
    state: 'Requested', link: 'https://example.com/sysapproval_approver.do?sys_id=14',
    freshness: 'historical', lastConfirmedAt: '2026-11-19T12:00:30Z',
  }],
};
const BADDATA = {
  state: 'found', freshness: 'historical', lastConfirmedAt: 'not-a-date',
  source: 'changes', number: 'CHG00000001', title: 'Synthetic change', status: 'Scheduled',
  link: 'https://example.com/change_request.do?sys_id=21', approvals: [],
};
const NULLLINK = {
  state: 'found', freshness: 'confirmed', source: 'work_tracker_stories', number: 'STRY00000003',
  title: 'Null link story', status: 'Open', link: null, approvals: [],
};

const RUNS = [{
  id: 101, createdAt: '2026-11-20T11:00:00Z', status: 'waiting', conclusion: null, head: 'release/example-a',
  link: 'https://github.com/org/repo-a/actions/runs/101',
  existingPrs: [{ number: 201, link: 'https://github.com/org/repo-a/pull/201' }],
}];
const PRS = [{
  number: 201, base: 'main', head: 'release/example-a', anomalies: ['stale_release'],
  link: 'https://github.com/org/repo-a/pull/201',
}];
const ISSUES = [{ part: 'annotations', repo: 'org/repo-a', runId: 101, error: 'The read command did not finish.' }];
const CHANGES = [
  { number: 'CHG00000001', link: 'https://example.com/change_request.do?sys_id=21' },
  { number: 'CHG00000005', link: null },
];
const PIPE_PARTIAL = { state: 'found', freshness: 'partial', runs: RUNS, prs: PRS, issues: ISSUES, changes: CHANGES };
const PIPE_CONFIRMED = { state: 'found', freshness: 'confirmed', runs: RUNS, prs: [], issues: [], changes: CHANGES.slice(0, 1) };
const PIPE_HIST = {
  state: 'found', freshness: 'historical', lastConfirmedAt: '2026-11-19T08:00:00Z',
  runs: RUNS, prs: [], issues: [], changes: [],
};
const PIPE_ABSENT = { state: 'absent' };
const PIPE_UNCONF = {
  state: 'unconfirmed',
  reason: 'the annotations collection for org/repo-a run 101 failed: The read command did not finish.',
  issues: [...ISSUES, { part: 'budget', limit: 120 }],
};

function chainPayload(id) {
  const baseBead = (bid, title, ref) => ({
    id: bid, projectId: 'demo', type: bid.startsWith('ep') ? 'epic' : 'task',
    status: 'open', title, ...(ref ? { externalRef: ref } : {}),
  });
  switch (id) {
    case 'ep-1':
      return {
        bead: baseBead('ep-1', 'Epic one', 'STRY00000001'),
        tracker: STORY,
        descendants: [
          { id: 'd-hist', type: 'task', status: 'open', title: 'Desc hist', externalRef: 'INC00000001', tracker: HIST },
          { id: 'd-partial', type: 'task', status: 'open', title: 'Desc partial', externalRef: 'STRY00000002', tracker: PARTIAL },
          { id: 'd-absent', type: 'task', status: 'open', title: 'Desc absent', externalRef: 'STRY00000009', tracker: ABSENT },
          { id: 'd-unconf', type: 'task', status: 'open', title: 'Desc unconf', externalRef: 'BUG00000001', tracker: UNCONFIRMED },
          { id: 'd-baddate', type: 'task', status: 'open', title: 'Desc baddate', externalRef: 'CHG00000002', tracker: BADDATA },
          { id: 'd-nulllink', type: 'task', status: 'open', title: 'Desc nulllink', externalRef: 'STRY00000003', tracker: NULLLINK },
        ],
        pipeline: PIPE_PARTIAL,
        snapshot: { available: true },
      };
    case 't-hist':
      return {
        bead: baseBead('t-hist', 'Historical task', 'STRY00000002'),
        tracker: HIST,
        epic: { id: 'ep-1', status: 'open', title: 'Epic one', externalRef: 'STRY00000001', tracker: STORY },
        pipeline: PIPE_HIST,
        snapshot: { available: true },
      };
    case 't-partial':
      return {
        bead: baseBead('t-partial', 'Partial task', 'INC00000001'),
        tracker: PARTIAL,
        epic: null,
        pipeline: PIPE_CONFIRMED,
        snapshot: { available: true },
      };
    case 't-absent':
      return {
        bead: baseBead('t-absent', 'Absent task', 'STRY00000009'),
        tracker: ABSENT,
        epic: null,
        pipeline: PIPE_ABSENT,
        snapshot: { available: true },
      };
    case 't-unconfirmed':
      return {
        bead: baseBead('t-unconfirmed', 'Unconfirmed task', 'BUG00000001'),
        tracker: UNCONFIRMED,
        epic: null,
        pipeline: PIPE_UNCONF,
        snapshot: { available: true },
      };
    case 't-baddate':
      return {
        bead: baseBead('t-baddate', 'Bad date task', 'CHG00000002'),
        tracker: BADDATA,
        epic: null,
        pipeline: PIPE_CONFIRMED,
        snapshot: { available: true },
      };
    case 't-empty':
      return {
        bead: { id: 't-empty', projectId: 'demo', type: 'task', status: 'open', title: 'Empty task' },
        tracker: null,
        epic: null,
        descendants: undefined,
        snapshot: { available: true },
      };
    case 't-error':
    case 't-loading':
      return {
        bead: baseBead(id, id === 't-error' ? 'Error task' : 'Loading task', 'STRY00000001'),
        tracker: STORY,
        epic: null,
        pipeline: PIPE_CONFIRMED,
        snapshot: { available: true },
      };
    case 'ep:colon':
      return {
        bead: { id: 'ep:colon', projectId: 'demo', type: 'epic', status: 'open', title: 'Colon epic', externalRef: 'STRY00000001' },
        tracker: STORY,
        descendants: [],
        pipeline: PIPE_CONFIRMED,
        snapshot: { available: true },
      };
    default:
      return {
        bead: { id, projectId: 'demo', type: 'task', status: 'open', title: `Title ${id}` },
        tracker: STORY,
        epic: null,
        pipeline: PIPE_CONFIRMED,
        snapshot: { available: true },
      };
  }
}

const browser = await chromium.launch();
const errors = [];
const unrouted = [];
let page;
let state;
let step = 'start';

async function open(url, { beads = projectBeads, chainEnabled = true } = {}) {
  await page?.context().close();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(`${step}: ${e.message}`));
  state = { beads, writes: [], chainPaths: [], chainEnabled, errorOnce: new Set(['t-error']), failEmpty: false };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path === '/api/viewer-mode' && method === 'GET') return route.fulfill({ json: { readOnly: false } });
    if (method !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ method, path, body });
      if (method === 'PATCH' && path.startsWith('/api/p/demo/beads/')) {
        const id = decodeURIComponent(path.split('/')[5]);
        const target = state.beads.find((b) => b.id === id);
        if (target) {
          Object.assign(target, body);
          if (body.external_ref === '') delete target.external_ref;
          return route.fulfill({ json: target });
        }
      }
      if (method === 'POST' && path.endsWith('/status')) {
        const id = decodeURIComponent(path.split('/')[5]);
        const target = state.beads.find((b) => b.id === id);
        if (target && body) {
          target.status = body.status;
          return route.fulfill({ json: target });
        }
      }
      // Writes on /all go to the real project; accept and echo an empty bead update.
      if (path.startsWith('/api/p/alpha/beads/')) {
        return route.fulfill({ json: {} });
      }
      unrouted.push(`${method} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'no fixture' } });
    }
    if (path === '/api/projects') {
      return route.fulfill({ json: { projects: [{ id: 'demo', name: 'Demo', path: null, hasBeads: true }, { id: 'alpha', name: 'Alpha App', path: null, hasBeads: true }] } });
    }
    if (path === '/api/p/demo/beads') {
      return route.fulfill({ json: { beads: state.beads, meta: { kind: 'br', humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 300_000 } } });
    }
    if (path === '/api/all/beads') {
      const mergedBeads = state.beads.map(merged);
      return route.fulfill({
        json: {
          beads: mergedBeads,
          meta: {
            kind: 'all', readOnly: false, humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 300_000,
            projects: [{ ...alpha, kind: 'br', count: mergedBeads.length }], failed: [],
          },
        },
      });
    }
    if (path === '/api/capabilities') {
      return route.fulfill({ json: { workDashboardUrl: null, chain: state.chainEnabled, notes: false, obsidianVault: null } });
    }
    if (path.endsWith('/order')) return route.fulfill({ json: { orders: {} } });
    if (path === '/api/p/demo/activity') return route.fulfill({ json: { items: [] } });
    const chainMatch = path.match(/^\/api\/p\/([^/]+)\/beads\/(.+)\/chain$/);
    if (chainMatch) {
      const beadId = decodeURIComponent(chainMatch[2]);
      state.chainPaths.push(path);
      if (beadId === 't-loading') {
        await new Promise((r) => setTimeout(r, 700));
      }
      if (state.errorOnce.has(beadId)) {
        state.errorOnce.delete(beadId);
        return route.fulfill({ status: 500, json: { error: 'chain failed' } });
      }
      return route.fulfill({ json: chainPayload(beadId) });
    }
    const single = state.beads.find((b) => path === `/api/p/demo/beads/${b.id}`);
    if (single) return route.fulfill({ json: single });
    // Single bead on alpha (drawer on /all reads its own project? chain covers it; answer empty).
    if (path.startsWith('/api/p/alpha/beads/')) {
      return route.fulfill({ json: {} });
    }
    unrouted.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'no fixture' } });
  });
  await page.goto(`${base}${url}`);
}

async function eventually(check, message) {
  const deadline = Date.now() + 8000;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `${step}: ${message}`);
    await page.waitForTimeout(50);
  }
}

const drawer = () => page.locator('[data-bead-drawer]');

async function openDrawer(id, opts) {
  await open(`/p/demo?view=board&bead=${encodeURIComponent(id)}`, opts);
  await page.getByRole('heading', { name: 'Relacionados', exact: true }).waitFor();
}

try {
  // ── Drawer: each tracker and pipeline state ───────────────────────────────
  step = 'drawer shows confirmed tracker and partial pipeline';
  await openDrawer('ep-1');
  const section = page.locator('[data-chain-section]');
  await section.getByText('STRY00000001', { exact: true }).first().waitFor();
  await section.getByText('Synthetic story', { exact: true }).first().waitFor();
  await section.getByText('Work in progress', { exact: true }).first().waitFor();
  await section.getByText('sprint-a', { exact: true }).first().waitFor();
  await section.getByText('confirmado', { exact: true }).first().waitFor();
  await section.getByText('parcial', { exact: true }).first().waitFor();
  // Pending approval beside fora do escopo coletado.
  await section.getByText('fora do escopo coletado', { exact: true }).first().waitFor();
  await section.getByText('CHG00000002', { exact: true }).first().waitFor();
  await section.getByText('Synthetic change outside the collected scope', { exact: true }).first().waitFor();
  // Approval record type, existing PR link, PR anomalies, null change link.
  await section.getByText('change_request', { exact: true }).first().waitFor();
  await section.getByText('https://github.com/org/repo-a/pull/201', { exact: true }).first().waitFor();
  await section.getByText('stale_release', { exact: true }).first().waitFor();
  await section.getByText('CHG00000005', { exact: true }).first().waitFor();
  assert.equal(await section.locator('[data-pipeline-change="CHG00000005"] a').count(), 0, 'a change with link null renders no anchor');
  // Epic and descendant tracker items.
  await section.getByText('d-hist', { exact: true }).first().waitFor();
  await section.getByText('INC00000001', { exact: true }).first().waitFor();
  // pt-BR date pattern and plain text for a date that does not parse.
  const histText = await section.locator('[data-tracker-state="historical"]').first().innerText();
  assert.match(histText, /\d{2}\/\d{2}\/\d{4}/, `historical date matches DD/MM/YYYY: ${histText}`);
  await section.getByText('not-a-date', { exact: false }).first().waitFor();
  // Null tracker link renders no anchor.
  assert.equal(await section.locator('[data-chain-descendant="d-nulllink"] a').count(), 0, 'a tracker with link null renders no anchor');
  // Every external link opens in a new tab with noopener noreferrer.
  const anchors = section.locator('a');
  const anchorCount = await anchors.count();
  assert.ok(anchorCount > 0, 'the section has external links');
  for (let i = 0; i < anchorCount; i++) {
    const a = anchors.nth(i);
    assert.equal(await a.getAttribute('target'), '_blank', `link ${i} targets a new tab`);
    assert.ok((await a.getAttribute('rel') ?? '').includes('noopener'), `link ${i} rel has noopener`);
    assert.ok((await a.getAttribute('rel') ?? '').includes('noreferrer'), `link ${i} rel has noreferrer`);
  }
  // Summary rows carry no keyboard bead id.
  assert.equal(await section.locator('[data-keyboard-bead-id]').count(), 0, 'chain summary rows are not keyboard candidates');
  // Absent is never called closed.
  const absentText = await section.locator('[data-tracker-state="absent"]').first().innerText();
  assert.ok(!absentText.toLowerCase().includes('fechado'), `absent never says fechado: ${absentText}`);

  step = 'drawer shows unconfirmed tracker and pipeline with issues';
  await openDrawer('t-unconfirmed');
  const unconf = page.locator('[data-chain-section]');
  await unconf.getByText('não confirmado', { exact: true }).first().waitFor();
  await unconf.getByText('ticket sources not collected ok and complete: incidents (error)', { exact: true }).first().waitFor();
  await unconf.getByText('annotations', { exact: true }).first().waitFor();
  await unconf.getByText('The read command did not finish.', { exact: true }).first().waitFor();

  step = 'drawer shows historical pipeline date';
  await openDrawer('t-hist');
  const histPipe = page.locator('[data-chain-section]');
  await histPipe.getByText('histórico, confirmado em', { exact: false }).first().waitFor();
  const pipeHistText = await histPipe.locator('[data-pipeline-state="historical"]').first().innerText();
  assert.match(pipeHistText, /\d{2}\/\d{2}\/\d{4}/, `pipeline historical date matches DD/MM/YYYY: ${pipeHistText}`);

  step = 'drawer shows absent pipeline';
  await openDrawer('t-absent');
  await page.locator('[data-pipeline-state="absent"]').getByText('fora do escopo coletado', { exact: true }).waitFor();

  step = 'drawer shows empty notice';
  await openDrawer('t-empty');
  await page.locator('[data-chain-section]').getByText('Nenhum item ligado a este bead.', { exact: true }).waitFor();

  step = 'drawer shows loading then content';
  await open('/p/demo?view=board&bead=t-loading');
  await page.locator('[data-chain-section]').getByText('Carregando relacionados…', { exact: true }).waitFor();
  await page.locator('[data-chain-section]').getByText('STRY00000001', { exact: true }).first().waitFor({ timeout: 10000 });

  step = 'drawer shows error with retry';
  await open('/p/demo?view=board&bead=t-error');
  await page.locator('[data-chain-section]').getByText('Não foi possível carregar os relacionados.', { exact: true }).waitFor();
  await page.locator('[data-chain-section]').getByRole('button', { name: 'Tentar de novo', exact: true }).click();
  await page.locator('[data-chain-section]').getByText('STRY00000001', { exact: true }).first().waitFor({ timeout: 10000 });

  // ── Saving a reference and changing status send a new chain request ───────
  step = 'saving a reference sends a new chain request';
  await open('/p/demo?view=board&bead=ep-1');
  await page.getByRole('heading', { name: 'Relacionados', exact: true }).waitFor();
  const beforeSave = state.chainPaths.length;
  assert.ok(beforeSave >= 1, 'the drawer requested the chain once');
  await drawer().getByTitle('Edit title & description', { exact: true }).click();
  const refInput = drawer().getByLabel('Referência externa', { exact: true });
  await refInput.fill('INC00000002');
  await drawer().getByRole('button', { name: 'Save', exact: true }).click();
  await eventually(async () => state.chainPaths.length > beforeSave, 'a reference save sends a new chain request');

  step = 'changing status sends a new chain request';
  await open('/p/demo?view=board&bead=ep-1');
  await page.getByRole('heading', { name: 'Relacionados', exact: true }).waitFor();
  const beforeStatus = state.chainPaths.length;
  await drawer().locator('select').first().selectOption('in_progress');
  await eventually(async () => state.chainPaths.length > beforeStatus, 'a status change sends a new chain request');

  // ── Epic view: no request before expand, one after (project page) ─────────
  step = 'epic view requests on expand on a project page';
  await open('/p/demo?view=epics');
  await page.getByRole('heading', { name: 'Epics', exact: true }).waitFor();
  await page.locator('[data-epic-id="ep-1"]').waitFor();
  assert.equal(state.chainPaths.filter((p) => p.includes('/chain')).length, 0, 'no chain request before an epic is expanded');
  await page.locator('[data-epic-id="ep-1"]').click();
  await page.locator('[data-epic-id="ep-1"] [data-chain-section]').waitFor();
  assert.equal(state.chainPaths.filter((p) => p.includes('/chain')).length, 1, 'one chain request after expanding');
  assert.ok(state.chainPaths[0].startsWith('/api/p/demo/beads/ep-1/chain'), `the request names the project and the id: ${state.chainPaths[0]}`);

  step = 'a local id with a colon is requested whole';
  await open('/p/demo?view=epics');
  await page.locator('[data-epic-id="ep:colon"]').waitFor();
  await page.locator('[data-epic-id="ep:colon"]').click();
  await page.locator('[data-epic-id="ep:colon"] [data-chain-section]').waitFor();
  const colonPath = state.chainPaths.find((p) => p.includes('/chain'));
  assert.ok(colonPath, 'a colon epic requested its chain');
  assert.ok(colonPath.includes('ep%3Acolon'), `the colon is encoded as %3A in the request path: ${colonPath}`);
  assert.ok(colonPath.startsWith('/api/p/demo/beads/ep%3Acolon/chain'), `the local id is requested whole: ${colonPath}`);

  // ── Epic view and drawer on /all name the real project ────────────────────
  step = 'epic view on /all names the real project and the local id';
  await open('/all?view=epics');
  await page.getByRole('heading', { name: 'Epics', exact: true }).waitFor();
  await page.locator('[data-epic-id="alpha:ep-1"]').waitFor();
  assert.equal(state.chainPaths.filter((p) => p.includes('/chain')).length, 0, 'no chain request on /all before expand');
  await page.locator('[data-epic-id="alpha:ep-1"]').click();
  await page.locator('[data-epic-id="alpha:ep-1"] [data-chain-section]').waitFor();
  const allPath = state.chainPaths.find((p) => p.includes('/chain'));
  assert.ok(allPath, 'an /all epic requested its chain');
  assert.ok(allPath.startsWith('/api/p/alpha/beads/ep-1/chain'), `the request names the real project and the local id: ${allPath}`);

  step = 'drawer on /all names the real project';
  await open('/all?view=board&bead=alpha:ep-1');
  await page.getByRole('heading', { name: 'Relacionados', exact: true }).waitFor();
  const drawerPath = state.chainPaths.find((p) => p.includes('/chain'));
  assert.ok(drawerPath, 'the /all drawer requested the chain');
  assert.ok(drawerPath.startsWith('/api/p/alpha/beads/ep-1/chain'), `the drawer request names the real project: ${drawerPath}`);

  // ── With chain false: no section and no request ────────────────────────────
  step = 'with chain false neither the drawer nor an expanded epic requests';
  await open('/p/demo?view=board&bead=ep-1', { chainEnabled: false });
  await drawer().getByRole('heading', { name: 'Epic one', exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-chain-section]').count(), 0, 'no section in the drawer when chain is false');
  assert.equal(state.chainPaths.length, 0, 'no chain request from the drawer when chain is false');
  await open('/p/demo?view=epics', { chainEnabled: false });
  await page.locator('[data-epic-id="ep-1"]').waitFor();
  await page.locator('[data-epic-id="ep-1"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-chain-section]').count(), 0, 'no section in an expanded epic when chain is false');
  assert.equal(state.chainPaths.length, 0, 'no chain request from an expanded epic when chain is false');

  assert.deepEqual(unrouted, [], `no stray requests: ${unrouted.join(', ')}`);
  assert.deepEqual(errors, []);
  console.log('PASS: chain drawer and epic view with fixtures');
} catch (e) {
  console.error({ step, errors, unrouted, url: page?.url(), chainPaths: state?.chainPaths });
  throw e;
} finally {
  await browser.close();
}
