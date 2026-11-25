// Settings field for the pipeline repository on /p/<id>?view=settings.
// Answers the API from fixtures so it passes under both launch modes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated server started from the current build');

const REPO = 'org/repo-a';
const browser = await chromium.launch();
let page;

const state = {
  repo: undefined,
  patches: [],
  puts: [],
  doctorGets: 0,
};

function doctorFor(id) {
  if (id === 'demo') {
    return {
      kind: 'demo',
      ok: true,
      version: '1.0',
      repoPath: '/tmp/demo',
      message: 'demo mode',
      project: { id: 'demo', name: 'Demo', path: null },
      config: { humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 30000 },
    };
  }
  return {
    kind: 'br',
    ok: true,
    version: '1.0',
    repoPath: '/tmp/alpha',
    message: 'ok',
    project: {
      id: 'alpha',
      name: 'Alpha',
      path: '/tmp/alpha',
      ...(state.repo !== undefined ? { pipelineRepo: state.repo } : {}),
    },
    config: { humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 30000 },
  };
}

function beadsFor(id) {
  return {
    beads: [],
    meta: {
      kind: id === 'demo' ? 'demo' : 'br',
      humanActor: 'reviewer',
      humanAllowlist: ['reviewer'],
      pollIntervalMs: 30000,
    },
  };
}

function projectsList() {
  return {
    projects: [
      { id: 'demo', name: 'Demo', path: null, hasBeads: true },
      {
        id: 'alpha',
        name: 'Alpha',
        path: '/tmp/alpha',
        hasBeads: true,
        ...(state.repo !== undefined ? { pipelineRepo: state.repo } : {}),
      },
    ],
  };
}

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/viewer-mode' && method === 'GET') {
      return route.fulfill({ json: { readOnly: false } });
    }
    if (path === '/api/projects' && method === 'GET') {
      return route.fulfill({ json: projectsList() });
    }
    if (path === '/api/p/alpha/doctor' && method === 'GET') {
      state.doctorGets += 1;
      return route.fulfill({ json: doctorFor('alpha') });
    }
    if (path === '/api/p/demo/doctor' && method === 'GET') {
      return route.fulfill({ json: doctorFor('demo') });
    }
    if ((path === '/api/p/alpha/beads' || path === '/api/p/demo/beads') && method === 'GET') {
      const id = path.includes('/alpha/') ? 'alpha' : 'demo';
      return route.fulfill({ json: beadsFor(id) });
    }
    if (path.endsWith('/beads/stream')) {
      return route.abort();
    }
    if (path === '/api/projects/alpha' && method === 'PATCH') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      state.patches.push(body);
      // Refuse an invalid repository like the route does.
      const repo = body.pipelineRepo;
      if (repo !== undefined && repo !== '' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/.test(repo)) {
        return route.fulfill({ status: 400, json: { error: 'Pipeline repository owner must use lowercase letters and digits with hyphens only inside.', code: 'invalid_config' } });
      }
      if (repo !== undefined) {
        if (repo === '') delete state.repo;
        else state.repo = repo;
      }
      return route.fulfill({
        json: {
          id: 'alpha',
          name: 'Alpha',
          path: '/tmp/alpha',
          ...(state.repo !== undefined ? { pipelineRepo: state.repo } : {}),
        },
      });
    }
    if (path === '/api/config' && method === 'PUT') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      state.puts.push(body);
      return route.fulfill({ json: { humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 30000 } });
    }
    if (method === 'GET') {
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: {} });
  });

  const field = () => page.getByLabel('Repositório do pipeline');
  const saveButton = () => page.getByRole('button', { name: 'Salvar', exact: true });

  // ---- registered project: save, clear, refusal, submit key, actor preservation ----
  await page.goto(`${base}/p/alpha?view=settings`);
  await field().waitFor();
  assert.equal(await field().inputValue(), '', 'the field starts empty when unset');

  // Save with surrounding whitespace: the client trims before sending.
  await field().fill('  org/repo-a  ');
  const doctorBefore = state.doctorGets;
  await saveButton().click();
  await page.waitForFunction(
    (expected) => window.document.body.innerText.includes(expected),
    REPO,
    { timeout: 10_000 },
  ).catch(() => {});
  assert.deepEqual(state.patches.at(-1), { pipelineRepo: REPO }, 'save sends the trimmed body');
  // A refetch resyncs the input: the fixture now carries the value.
  await page.waitForFunction(
    () => document.querySelector('input[placeholder="org/repo-a"]')?.value === 'org/repo-a',
    null,
    { timeout: 10_000 },
  );
  assert.equal(await field().inputValue(), REPO, 'a refetch resyncs the input');
  assert.ok(state.doctorGets > doctorBefore, 'a save refetches the doctor');

  // Clear with an empty string.
  await field().fill('');
  await saveButton().click();
  await page.waitForTimeout(500);
  assert.deepEqual(state.patches.at(-1), { pipelineRepo: '' }, 'clear sends an empty string');
  assert.equal(state.repo, undefined, 'the fixture cleared the value');

  // An invalid repository shows the refusal inline.
  await field().fill('Bad/Repo');
  await saveButton().click();
  await page.getByText(/lowercase/i).waitFor();
  assert.ok((await page.getByText(/lowercase/i).count()) > 0, 'the refusal is shown under the field');

  // Typing clears the refusal.
  await field().fill('Bad/Repo-x');
  assert.equal(await page.getByText(/lowercase/i).count(), 0, 'editing clears the refusal');

  // A following valid save clears it too.
  await field().fill(REPO);
  await saveButton().click();
  await page.waitForTimeout(500);
  assert.deepEqual(state.patches.at(-1), { pipelineRepo: REPO }, 'a valid save follows the refusal');
  assert.equal(await page.getByText(/lowercase/i).count(), 0, 'a valid save clears the refusal');

  // Control+Enter sends PATCH and no PUT /api/config.
  state.patches.length = 0;
  state.puts.length = 0;
  await field().fill('org/repo-b');
  await field().press('Control+Enter');
  await page.waitForFunction(() => window.document.body.innerText.includes('org/repo-b'), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  assert.ok(state.patches.length >= 1, 'Control+Enter sends a PATCH');
  assert.deepEqual(state.patches.at(-1), { pipelineRepo: 'org/repo-b' }, 'Control+Enter sends only the repository');
  assert.deepEqual(state.puts, [], 'Control+Enter sends no PUT /api/config');

  // An actor typed and not saved survives the field save.
  const actor = page.getByLabel(/Human actor/);
  await actor.waitFor();
  await actor.fill('unsaved-actor');
  await field().fill(REPO);
  await saveButton().click();
  await page.waitForTimeout(800);
  assert.equal(await actor.inputValue(), 'unsaved-actor', 'an unsaved actor edit survives the field save');
  assert.deepEqual(state.patches.at(-1), { pipelineRepo: REPO }, 'the field save still sends only the repository');

  // ---- demo project: no field ----
  await page.goto(`${base}/p/demo?view=settings`);
  await page.getByText(/built-in sample data/).waitFor();
  assert.equal(await page.getByLabel('Repositório do pipeline').count(), 0, 'the demo shows no field');

  console.log(`PASS: settings field saves ${REPO}, clears, refuses inline, submits on Control+Enter without touching global config, keeps an unsaved actor, hides on demo`);
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator('body').innerText()).slice(0, 3000) : '' });
  throw error;
} finally {
  await browser.close();
}
