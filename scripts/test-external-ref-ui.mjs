// external_ref in the interface: the drawer, the create form, the board and list search, the epic
// view's filter and the command palette. Every API request is answered from the fixtures below,
// the viewer mode included, so no tracker is read or written and the script passes under both
// launch modes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated server started from the current build');

const T = '2026-09-01T00:00:00Z';
const LABEL = 'Referência externa';
const FILTER = 'Filtrar épicos';
const NO_MATCH = 'Nenhum épico corresponde ao filtro.';
const NO_EPICS = 'No epics yet. Create one with type “epic”.';

const bead = (id, title, extra = {}) => ({
  id, title, description: 'Body', status: 'open', issue_type: 'task', priority: 2,
  labels: [], dependencies: [], comments: [], created_at: T, updated_at: T, ...extra,
});
const epic = (id, title, extra = {}) => bead(id, title, { issue_type: 'epic', ...extra });
const childOf = (id, title, parent) =>
  bead(id, title, { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] });

// Enough epics above the jump targets that a target left unscrolled would be off screen.
const fillers = Array.from({ length: 14 }, (_, i) =>
  epic(`ep-f${String(i).padStart(2, '0')}`, `Filler epic ${i}`, { priority: 0 }));

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
  ...fillers,
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
    // The sidebar reads which optional features exist; none is configured here.
    if (path === '/api/capabilities') return route.fulfill({ json: { workDashboardUrl: null, chain: false } });
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

const shownEpics = () => page.locator('[data-epic-id]').evaluateAll((es) => es.map((e) => e.dataset.epicId));
async function expectEpics(expected, what) {
  const wanted = JSON.stringify([...expected].sort());
  let last;
  await eventually(async () => {
    last = JSON.stringify((await shownEpics()).sort());
    return last === wanted;
  }, `${what}: expected ${wanted}`);
}
const epicFilter = () => page.getByRole('textbox', { name: FILTER, exact: true });
const epicsHeader = () => page.locator('header').filter({ has: page.getByRole('heading', { name: 'Epics', exact: true }) });
const epicCount = () => epicsHeader().locator('span').first().innerText();
const param = (name) => new URL(page.url()).searchParams.get(name);

const paletteItems = () => page.locator('[cmdk-item]').allInnerTexts();
async function paletteBeads(search) {
  await page.locator('[cmdk-input]').fill(search);
  await page.waitForTimeout(200);
  return (await paletteItems()).map((text) => text.match(/\b(?:hs|ep)-\w+/)?.[0]).filter(Boolean);
}
async function openPalette() {
  await page.keyboard.press('Control+k');
  await page.locator('[cmdk-input]').waitFor();
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

  // ── Epic view filter ───────────────────────────────────────────────────────
  step = 'epic filter on a project page';
  await open('/p/demo?view=epics&custom=keep');
  const allEpics = projectBeads().filter((b) => b.issue_type === 'epic').map((b) => b.id);
  const openEpics = allEpics.filter((id) => id !== 'ep-4');
  const total = allEpics.length;
  await expectEpics(openEpics, 'no filter');
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), FILTER, '/ focuses the epic filter');
  assert.equal(await epicFilter().inputValue(), '', 'the shortcut key is not typed into it');
  await page.keyboard.type('stry00000555');
  await expectEpics(['ep-2'], 'by reference');
  assert.equal(param('q'), 'stry00000555', 'the filter is the URL’s q');
  assert.equal(param('custom'), 'keep', 'other parameters stay');
  assert.match(await epicCount(), new RegExp(`^1 of ${total} epics`), 'the header counts what the filter left');
  await epicFilter().fill('billing');
  await expectEpics(['ep-1'], 'by title');
  await epicFilter().fill('EP-3');
  await expectEpics(['ep-3'], 'by id');
  await epicFilter().fill('INC00000001');
  await expectEpics(['ep-3'], 'by another reference');

  step = 'no match';
  await epicFilter().fill('CHG00000001');
  await page.getByText(NO_MATCH, { exact: true }).waitFor();
  assert.equal(await page.getByText(NO_EPICS, { exact: true }).count(), 0, 'a filter with no match does not claim there are no epics');
  await page.getByRole('button', { name: 'Show Closed', exact: true }).click();
  await expectEpics(['ep-4'], 'a closed epic by reference, with closed ones shown');
  assert.match(await epicCount(), new RegExp(`^1 of ${total} epics`), 'the count shows although nothing hides closed epics');
  await epicFilter().fill('');
  await expectEpics(allEpics, 'filter emptied');
  assert.match(await epicCount(), new RegExp(`^${total} epics`), 'an unfiltered list has no "of" count');
  assert.equal(param('q'), null, 'an emptied filter leaves no q');
  assert.equal(await page.getByText(NO_MATCH, { exact: true }).count(), 0);

  step = 'bookmarked filter';
  await open('/p/demo?view=epics&q=STRY00000555');
  await expectEpics(['ep-2'], 'from the URL');
  assert.equal(await epicFilter().inputValue(), 'STRY00000555', 'the input shows the URL’s q');

  step = 'no epics at all';
  await open('/p/demo?view=epics', { beads: [bead('hs-1', 'Story card')] });
  await page.getByText(NO_EPICS, { exact: true }).waitFor();
  assert.equal(await page.getByText(NO_MATCH, { exact: true }).count(), 0, 'an empty filter keeps the old empty state');

  step = 'epic filter on /all';
  await open('/all?view=epics');
  await expectEpics(openEpics.map((id) => `alpha:${id}`), 'no filter');
  await epicFilter().fill('STRY00000555');
  await expectEpics(['alpha:ep-2'], 'by reference');
  await epicFilter().fill('ep-3');
  await expectEpics(['alpha:ep-3'], 'by the id shown');
  await epicFilter().fill('alpha:');
  await page.getByText(NO_MATCH, { exact: true }).waitFor();

  // ── Jumping from the list to an epic ───────────────────────────────────────
  async function jump(path, { search, parentTitle, epicId }) {
    await open(`${path}${path.includes('?') ? '&' : '?'}view=list&custom=keep&q=${encodeURIComponent(search)}`);
    const chip = page.getByTitle(parentTitle, { exact: true });
    await chip.waitFor();
    // A target that leaves the page for one render and comes back ends up looking right.
    await page.evaluate((id) => {
      window.__removed = 0;
      const selector = `[data-epic-id="${id}"]`;
      new MutationObserver((records) => {
        for (const node of records.flatMap((r) => [...r.removedNodes])) {
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) window.__removed += 1;
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, epicId);
    const entries = await page.evaluate(() => history.length);
    await chip.click();
    await page.getByRole('heading', { name: 'Epics', exact: true }).waitFor();
    // Past the focus frame, the smooth scroll and the 1.6 s flash.
    await page.waitForTimeout(2200);
    const section = page.locator(`[data-epic-id="${epicId}"]`);
    assert.equal(await section.count(), 1, `${step}: the epic is shown once the focus has settled`);
    assert.equal(await section.getByRole('button').first().getAttribute('aria-expanded'), 'true', `${step}: and expanded`);
    assert.equal(await page.evaluate(() => window.__removed), 0, `${step}: and never left the page on the way`);
    assert.equal(await page.evaluate(() => history.length), entries + 1, `${step}: the jump adds the view's history entry and no other`);
    assert.equal(param('view'), 'epics');
    assert.equal(param('custom'), 'keep', `${step}: other parameters stay`);
    const box = await section.boundingBox();
    assert.ok(box.y >= 0 && box.y < page.viewportSize().height - 40, `${step}: the epic is on screen (top at ${box.y})`);
  }

  for (const target of [
    { path: '/p/demo', search: 'child card', parentTitle: 'ep-9 · Target rework · P4', epicId: 'ep-9' },
    { path: '/p/demo', search: 'Orphan', parentTitle: 'ep-4 · Archive rework · P4', epicId: 'ep-4' },
    { path: '/all', search: 'child card', parentTitle: 'ep-9 · Target rework · P4', epicId: 'alpha:ep-9' },
  ]) {
    step = `jump to ${target.epicId} while the filter excludes it`;
    await jump(target.path, target);
    assert.equal(param('q'), null, `${step}: the filter is cleared`);
    assert.equal(await epicFilter().inputValue(), '', `${step}: and so is the input`);
    assert.ok((await shownEpics()).length >= openEpics.length, `${step}: the other epics are back`);
    await page.goBack();
    await page.getByRole('heading', { name: 'List', exact: true }).waitFor();
    assert.equal(param('q'), target.search, `${step}: Back returns to the filtered list`);
  }

  step = 'jump while the filter matches the epic';
  await jump('/p/demo', { search: 'Target', parentTitle: 'ep-9 · Target rework · P4', epicId: 'ep-9' });
  assert.equal(param('q'), 'Target', 'a filter that matches the epic is kept');
  await expectEpics(['ep-9'], 'still filtered');

  // ── Narrow screen ──────────────────────────────────────────────────────────
  for (const url of ['/p/demo?view=epics&q=rework', '/all?view=epics&q=rework']) {
    step = `390 pixels: ${url}`;
    await open(url, { viewport: { width: 390, height: 844 } });
    await epicFilter().waitFor();
    await eventually(async () => (await epicCount()).includes(' of '), 'the epics are listed');
    const overflow = await epicsHeader().evaluate((header) => ({
      scroll: header.scrollWidth - header.clientWidth,
      outside: [...header.querySelectorAll('*')]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && (r.left < -0.5 || r.right > window.innerWidth + 0.5)).length,
    }));
    assert.deepEqual(overflow, { scroll: 0, outside: 0 }, `${step}: the header does not overflow`);
    // Without wrapping nothing overflows either: the filter is squeezed beside the buttons instead.
    const { width } = await epicFilter().locator('xpath=..').boundingBox();
    assert.ok(width >= 200, `${step}: the header wraps and the filter keeps its width (${width})`);
  }

  // ── Command palette ────────────────────────────────────────────────────────
  step = 'palette';
  const holds = (text, word) => {
    let at = 0;
    for (const letter of text.toLowerCase()) if (letter === word[at]) at += 1;
    return at === word.length;
  };
  const unreferenced = projectBeads().filter((b) => !b.external_ref?.trim());
  for (const b of unreferenced) {
    for (const word of ['null', 'undefined']) {
      assert.equal(holds(`recent ${b.id} ${b.title}`, word), false, `fixture: ${b.id} must not spell "${word}"`);
    }
  }
  await open('/p/demo?view=board');
  await card('hs-1').waitFor();
  await openPalette();
  assert.deepEqual(await paletteBeads('STRY00000001'), ['hs-1'], 'the palette finds a bead by its reference');
  assert.deepEqual(await paletteBeads('STRY00000002'), ['hs-2'], 'and by a reference stored with blanks');
  assert.deepEqual(await paletteBeads('STRY00000555'), ['ep-2'], 'and an epic by its reference');
  for (const id of ['hs-3', 'hs-4', 'hs-5']) {
    const { title } = unreferenced.find((b) => b.id === id);
    assert.ok((await paletteBeads(title)).includes(id), `${id} is listed by its title`);
  }
  for (const word of ['undefined', 'null']) {
    assert.deepEqual(await paletteBeads(word), [], `no bead without a reference matches "${word}"`);
  }

  // ── A story number typed in the drawer finds its epic ──────────────────────
  step = 'from the drawer to the epic view and the palette';
  await open('/p/demo?view=epics');
  await page.getByRole('button', { name: 'Open details for ep-1', exact: true }).click();
  await editButton().click();
  await refInput().fill('STRY00000040');
  await saved('ep-1', () => saveButton().click());
  await drawer().getByTitle('Close', { exact: true }).click();
  await drawer().waitFor({ state: 'detached' });
  await epicFilter().fill('STRY00000040');
  await expectEpics(['ep-1'], 'the epic view finds it');
  await epicFilter().blur();
  await openPalette();
  assert.deepEqual(await paletteBeads('STRY00000040'), ['ep-1'], 'the palette finds it');

  assert.deepEqual(unrouted, [], 'every request had a fixture');
  assert.deepEqual(errors, [], 'no page error');
  console.log('PASS external_ref UI: drawer, create form, board and list search, epic filter and jump, narrow header, shortcuts and palette');
} catch (error) {
  // First, and on one line: it is what scripts/mutate-check.py reports as the reason.
  console.error(`Error at step "${step}": ${error.message.split('\n')[0]}`);
  console.error({ url: page?.url(), errors, unrouted, writes: state?.writes });
  throw error;
} finally {
  await browser.close();
}
