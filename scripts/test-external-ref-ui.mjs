// external_ref in the interface: the drawer, the create form and the board and list search. Every
// API request is answered from the fixtures below, the viewer mode included, so no tracker is
// read or written and the script passes under both launch modes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated server started from the current build');

const T = '2026-09-01T00:00:00Z';
const LABEL = 'Referência externa';

const bead = (id, title, extra = {}) => ({
  id, title, description: 'Body', status: 'open', issue_type: 'task', priority: 2,
  labels: [], dependencies: [], comments: [], created_at: T, updated_at: T, ...extra,
});
const epic = (id, title, extra = {}) => bead(id, title, { issue_type: 'epic', ...extra });
const childOf = (id, title, parent) =>
  bead(id, title, { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] });

const projectBeads = () => [
  bead('hs-1', 'Story card', { external_ref: 'STRY00000001' }),
  bead('hs-2', 'Spaced card', { external_ref: '  STRY00000002  ' }),
  bead('hs-3', 'Bare card'),
  bead('hs-4', 'Empty slot card', { external_ref: null }),
  bead('hs-5', 'Blank card', { external_ref: '   ' }),
  epic('ep-1', 'Billing rework'),
  epic('ep-2', 'Search rework', { external_ref: 'STRY00000555' }),
  epic('ep-3', 'Import rework', { external_ref: 'INC00000001' }),
  epic('ep-4', 'Archive rework', { status: 'closed', priority: 4, external_ref: 'CHG00000001' }),
  epic('ep-9', 'Target rework', { priority: 4 }),
  childOf('hs-8', 'Orphan card', 'ep-4'),
  childOf('hs-9', 'Target child card', 'ep-9'),
];

const alpha = { id: 'alpha', name: 'Alpha App' };
/** A bead the way lib/aggregate.ts namespaces it. */
const merged = (b) => ({
  ...b,
  id: `${alpha.id}:${b.id}`,
  local_id: b.id,
  project: alpha,
  dependencies: b.dependencies.map((d) => ({
    ...d,
    issue_id: `${alpha.id}:${d.issue_id}`,
    depends_on_id: `${alpha.id}:${d.depends_on_id}`,
  })),
});

const browser = await chromium.launch();
const errors = [];
const unrouted = [];
let page;
let state;
let step = 'start';

async function open(url, { beads = projectBeads(), readOnly = false, viewport = { width: 1500, height: 1000 } } = {}) {
  await page?.context().close();
  const context = await browser.newContext({ viewport });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(`${step}: ${e.message}`));
  state = { beads, writes: [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path === '/api/viewer-mode' && method === 'GET') return route.fulfill({ json: { readOnly } });
    if (method !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ method, path, body });
      if (method === 'POST' && path === '/api/p/demo/beads') {
        const made = bead('hs-new', body.title, body.external_ref ? { external_ref: body.external_ref } : {});
        state.beads.push(made);
        return route.fulfill({ json: made });
      }
      const target = state.beads.find((b) => path === `/api/p/demo/beads/${b.id}`);
      if (method === 'PATCH' && target) {
        Object.assign(target, body);
        if (body.external_ref === '') delete target.external_ref;
        return route.fulfill({ json: target });
      }
      unrouted.push(`${method} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'no fixture' } });
    }
    if (path === '/api/projects') {
      return route.fulfill({ json: { projects: [{ id: 'demo', name: 'Demo', path: null, hasBeads: true }] } });
    }
    if (path === '/api/p/demo/beads') {
      const meta = { kind: 'br', humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 300_000 };
      return route.fulfill({ json: { beads: state.beads, meta } });
    }
    if (path === '/api/all/beads') {
      const meta = {
        kind: 'all', readOnly, humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 300_000,
        projects: [{ ...alpha, kind: 'br', count: state.beads.length }], failed: [],
      };
      return route.fulfill({ json: { beads: state.beads.map(merged), meta } });
    }
    if (path.endsWith('/order')) return route.fulfill({ json: { orders: {} } });
    if (path === '/api/p/demo/activity') return route.fulfill({ json: { items: [] } });
    const single = state.beads.find((b) => path === `/api/p/demo/beads/${b.id}`);
    if (single) return route.fulfill({ json: single });
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
const createDialog = () => page.getByRole('dialog');
const refLabel = () => drawer().getByText(LABEL, { exact: true });
const refInput = () => drawer().getByLabel(LABEL, { exact: true });
const titleInput = () => drawer().getByPlaceholder('Title', { exact: true });
const editButton = () => drawer().getByTitle('Edit title & description', { exact: true });
const saveButton = () => drawer().getByRole('button', { name: 'Save', exact: true });
const clickOutside = () => page.mouse.click(8, 990);
const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`).first();

async function openDrawer(id, options) {
  await open(`/p/demo?view=board&bead=${id}`, options);
  await drawer().getByRole('heading', { name: state.beads.find((b) => b.id === id).title, exact: true }).waitFor();
}

/** The read row as text: its label followed by exactly the value shown. */
const readRow = () => refLabel().locator('xpath=..').textContent();

/** Runs one save and returns the body it sent, once the drawer is back in read mode. */
async function saved(id, action) {
  const before = state.writes.length;
  await action();
  await editButton().waitFor();
  assert.equal(state.writes.length, before + 1, `${step}: one write`);
  const write = state.writes.at(-1);
  assert.deepEqual([write.method, write.path], ['PATCH', `/api/p/demo/beads/${id}`], `${step}: the write is an update of ${id}`);
  return write.body;
}

try {
  // ── Drawer, read mode ──────────────────────────────────────────────────────
  step = 'drawer shows the reference';
  await openDrawer('hs-1');
  assert.equal(await readRow(), `${LABEL}STRY00000001`, 'the drawer shows the reference');
  await openDrawer('hs-2');
  assert.equal(await readRow(), `${LABEL}STRY00000002`, 'the drawer shows the reference trimmed');
  for (const id of ['hs-3', 'hs-4', 'hs-5']) {
    step = `no reference row for ${id}`;
    await openDrawer(id);
    assert.equal(await refLabel().count(), 0, `${id}: an absent, null or blank reference shows nothing`);
  }
  step = 'read-only drawer';
  await openDrawer('hs-1', { readOnly: true });
  // The open drawer hides the rest of the page from the accessibility tree.
  await page.getByRole('button', { name: 'Read Only Mode', exact: true, includeHidden: true }).waitFor();
  assert.equal(await readRow(), `${LABEL}STRY00000001`, 'a read-only drawer shows the reference');
  assert.equal(await refInput().count(), 0, 'a read-only drawer offers no input');

  // ── Drawer, editing ────────────────────────────────────────────────────────
  step = 'label appears once while editing';
  await openDrawer('hs-1');
  await editButton().click();
  assert.equal(await refInput().inputValue(), 'STRY00000001', 'the draft starts from the bead');
  assert.equal(await refLabel().count(), 1, 'while editing the label appears once');
  await drawer().getByRole('button', { name: 'Preview', exact: true }).click();
  await refInput().waitFor();
  assert.equal(await refLabel().count(), 1, 'the input stays, once, while the description is previewed');

  step = 'untouched edit closes on an outside click';
  await openDrawer('hs-2');
  await editButton().click();
  await refInput().waitFor();
  await clickOutside();
  await drawer().waitFor({ state: 'detached' });

  step = 'a typed reference survives an outside click';
  await openDrawer('hs-1');
  await editButton().click();
  await refInput().fill('  INC00000002  ');
  await clickOutside();
  await page.getByText('You have unsaved changes').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await drawer().count(), 1, 'a drawer with a typed reference stays open on an outside click');
  assert.equal(await refInput().inputValue(), '  INC00000002  ', 'and keeps what was typed');
  assert.deepEqual(
    await saved('hs-1', () => saveButton().click()),
    { title: 'Story card', description: 'Body', external_ref: 'INC00000002' },
    'a new reference is sent trimmed, beside the title and the description',
  );
  assert.equal(await readRow(), `${LABEL}INC00000002`, 'the drawer shows the saved reference');

  step = 'clear the reference';
  await editButton().click();
  await refInput().fill('');
  assert.deepEqual(
    await saved('hs-1', () => saveButton().click()),
    { title: 'Story card', description: 'Body', external_ref: '' },
    'a cleared reference is sent as an empty string',
  );
  await eventually(async () => (await refLabel().count()) === 0, 'a cleared reference leaves no row');

  for (const [id, title] of [['hs-1', 'Story card'], ['hs-2', 'Spaced card'], ['hs-3', 'Bare card'], ['hs-4', 'Empty slot card'], ['hs-5', 'Blank card']]) {
    step = `title-only edit of ${id}`;
    await openDrawer(id);
    await editButton().click();
    await titleInput().fill(`${title} renamed`);
    assert.deepEqual(
      await saved(id, () => saveButton().click()),
      { title: `${title} renamed`, description: 'Body' },
      `${id}: an edit of the title alone sends no reference`,
    );
  }

  step = 'blanks around a stored reference are no change';
  await openDrawer('hs-2');
  await editButton().click();
  await refInput().fill('STRY00000002 ');
  assert.deepEqual(
    await saved('hs-2', () => saveButton().click()),
    { title: 'Spaced card', description: 'Body' },
    'a draft that differs only in blanks is not sent',
  );

  step = 'cancel and edit again';
  await openDrawer('hs-1');
  for (const cancel of [
    () => drawer().getByRole('button', { name: 'Cancel', exact: true }).click(),
    () => drawer().getByTitle('Stop editing', { exact: true }).click(),
  ]) {
    await editButton().click();
    await refInput().fill('CHG00000009');
    await cancel();
    await editButton().click();
    assert.equal(await refInput().inputValue(), 'STRY00000001', 'the draft is the bead’s value, not the abandoned one');
    await cancel();
  }
  assert.deepEqual(state.writes, [], 'a cancelled edit writes nothing');

  step = 'opening straight into edit, and Control+Enter';
  await open('/p/demo?view=board');
  await card('hs-1').focus();
  await page.keyboard.press('e');
  await refInput().waitFor();
  assert.equal(await refInput().inputValue(), 'STRY00000001', 'a drawer opened into edit starts from the bead');
  await refInput().fill('CHG00000002');
  await refInput().press('Enter');
  await page.waitForTimeout(200);
  assert.deepEqual(state.writes, [], 'Enter alone saves nothing');
  assert.deepEqual(
    await saved('hs-1', () => refInput().press('Control+Enter')),
    { title: 'Story card', description: 'Body', external_ref: 'CHG00000002' },
    'Control+Enter in the reference input saves',
  );

  // ── Create form ────────────────────────────────────────────────────────────
  step = 'create form keeps a typed reference';
  await open('/p/demo?view=board');
  await card('hs-1').waitFor();
  await page.keyboard.press('n');
  const createRef = () => createDialog().getByLabel(LABEL, { exact: true });
  await createRef().fill('  STRY00000020  ');
  await clickOutside();
  await page.getByText("Your new bead isn't saved yet").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await createDialog().count(), 1, 'a create form holding only a reference survives an outside click');
  assert.equal(await createRef().inputValue(), '  STRY00000020  ', 'and keeps what was typed');
  await createDialog().getByPlaceholder('What needs doing?').fill('Made with a reference');
  await createDialog().getByRole('button', { name: 'Create bead', exact: true }).click();
  await createDialog().waitFor({ state: 'detached' });
  assert.equal(state.writes.at(-1).body.external_ref, 'STRY00000020', 'the create body carries the reference');

  for (const blank of ['', '   ']) {
    step = `create with the reference ${JSON.stringify(blank)}`;
    await page.keyboard.press('n');
    await createRef().fill(blank);
    await createDialog().getByPlaceholder('What needs doing?').fill('Made without one');
    await createDialog().getByRole('button', { name: 'Create bead', exact: true }).click();
    await createDialog().waitFor({ state: 'detached' });
    assert.equal(state.writes.at(-1).body.title, 'Made without one');
    assert.equal(Object.hasOwn(state.writes.at(-1).body, 'external_ref'), false, 'a blank reference is not sent');
  }

  // ── Board and list search ──────────────────────────────────────────────────
  for (const view of ['board', 'list']) {
    step = `${view} search by reference`;
    await open(`/p/demo?view=${view}&q=STRY00000001`);
    await card('hs-1').waitFor();
    const ids = await page.locator('main [data-keyboard-bead-id]').evaluateAll((es) => es.map((e) => e.dataset.keyboardBeadId));
    assert.deepEqual([...new Set(ids)], ['hs-1'], `the ${view} shows only the bead carrying the reference`);
  }

  assert.deepEqual(unrouted, [], 'every request had a fixture');
  assert.deepEqual(errors, [], 'no page error');
  console.log('PASS external_ref UI: drawer, create form and board and list search');
} catch (error) {
  // First, and on one line: it is what scripts/mutate-check.py reports as the reason.
  console.error(`Error at step "${step}": ${error.message.split('\n')[0]}`);
  console.error({ url: page?.url(), errors, unrouted, writes: state?.writes });
  throw error;
} finally {
  await browser.close();
}
