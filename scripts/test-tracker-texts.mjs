// Verifies the six tracker-aware UI texts across the launcher, a br project, a bd project, and the
// merged all-projects page. Every /api/ request is answered from fixtures through page.route so no
// real tracker is read or written, and the delete confirmation dialog is read and dismissed.
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const demo = { id: "demo", name: "Demo", path: null, hasBeads: true };
const alpha = { id: "alpha", name: "Alpha App", path: "/fixture/alpha", hasBeads: true, kind: "br" };
const beta = { id: "beta", name: "Beta Tools", path: "/fixture/beta", hasBeads: true, kind: "bd" };

function makeBead(id, title) {
  return {
    id,
    title,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "",
    labels: [],
    comments: [],
    dependencies: [],
    created_by: "reviewer",
    created_at: T,
    updated_at: T,
  };
}

function mergedBead(project, bead) {
  return {
    ...structuredClone(bead),
    id: `${project.id}:${bead.id}`,
    local_id: bead.id,
    project: { id: project.id, name: project.name },
  };
}

const projectBeads = {
  alpha: [makeBead("ab-1", "Alpha one")],
  beta: [makeBead("ab-1", "Beta one")],
};

// Tiny SSE responder on an ephemeral localhost port so EventSource genuinely opens and stays live
// when a scenario wants to observe ProjectSwitcher in its connected ("live") state.
const openStreams = new Set();
const sseServer = http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  openStreams.add(res);
  res.on("close", () => openStreams.delete(res));
});
await new Promise((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
const sseUrl = `http://127.0.0.1:${sseServer.address().port}/stream`;

const browser = await chromium.launch();
let page;
let step = "start";

async function openScenario(url, { liveStream = false, holdBeads = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);

  const state = {
    viewerAnswers: 0,
    unexpected: [],
    nonGet: [],
    releaseBeads: null,
    beadsGate: null,
  };
  if (holdBeads) {
    state.beadsGate = new Promise((resolve) => {
      state.releaseBeads = resolve;
    });
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === "/api/update/check") {
      return route.fulfill({ json: {} });
    }
    if (method !== "GET") {
      state.nonGet.push(`${method} ${path}`);
      return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${path}` } });
    }
    if (path === "/api/viewer-mode") {
      state.viewerAnswers += 1;
      return route.fulfill({ json: { readOnly: false } });
    }
    if (path === "/api/projects") {
      return route.fulfill({
        json: {
          projects: [demo, alpha, beta].map(({ id, name, path: p, hasBeads }) => ({
            id,
            name,
            path: p,
            hasBeads,
          })),
        },
      });
    }
    if (path === "/api/all/beads") {
      if (state.beadsGate) await state.beadsGate;
      return route.fulfill({
        json: {
          beads: [alpha, beta].flatMap((p) => projectBeads[p.id].map((b) => mergedBead(p, b))),
          meta: {
            kind: "all",
            readOnly: false,
            humanActor: "reviewer",
            humanAllowlist: ["reviewer"],
            pollIntervalMs: 300_000,
            projects: [
              { id: alpha.id, name: alpha.name, kind: alpha.kind, count: projectBeads.alpha.length },
              { id: beta.id, name: beta.name, kind: beta.kind, count: projectBeads.beta.length },
            ],
            failed: [],
          },
        },
      });
    }
    if (path === "/api/all/beads/stream") {
      return route.abort();
    }
    const streamMatch = path.match(/^\/api\/p\/([^/]+)\/beads\/stream$/);
    if (streamMatch) {
      if (liveStream) return route.continue({ url: sseUrl });
      return route.abort();
    }
    const beadsMatch = path.match(/^\/api\/p\/([^/]+)\/beads$/);
    if (beadsMatch) {
      if (state.beadsGate) await state.beadsGate;
      const project = [alpha, beta].find((p) => p.id === beadsMatch[1]);
      if (project) {
        return route.fulfill({
          json: {
            beads: structuredClone(projectBeads[project.id]),
            meta: {
              kind: project.kind,
              humanActor: "reviewer",
              humanAllowlist: ["reviewer"],
              pollIntervalMs: 300_000,
            },
          },
        });
      }
    }
    if (path.endsWith("/order")) {
      return route.fulfill({ json: { orders: {} } });
    }
    if (path.endsWith("/activity")) {
      return route.fulfill({ json: { items: [] } });
    }
    state.unexpected.push(path);
    return route.fulfill({ json: {} });
  });

  await page.goto(`${base}${url}`);
  return { context, state };
}

async function waitForViewerMode(state) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (state.viewerAnswers > 0) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(state.viewerAnswers > 0, `${step}: /api/viewer-mode answered`);
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const drawer = () => page.locator("[data-bead-drawer]");
const createDialog = () =>
  page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Create bead" }) });
const chooser = () =>
  page.getByRole("dialog").filter({ hasText: "Which project is it for?" });
const boardSubtitle = () =>
  page.locator("header").filter({ has: page.getByRole("heading", { name: "Board", exact: true }) }).locator("h1 + span");
const switcherSubline = (projectName) =>
  page
    .getByRole("button", { name: `Select project, current project ${projectName}`, exact: true })
    .first()
    .locator("div > div")
    .nth(1);

async function readCreateHint() {
  await createDialog().waitFor();
  return (await createDialog().locator("p").first().innerText()).trim();
}

async function checkDrawerTexts(label, beadId, expectedTracker) {
  step = `${label}: delete confirmation`;
  let confirmMessage = null;
  const dialogHandled = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      confirmMessage = dialog.message();
      await dialog.dismiss();
      resolve();
    });
  });
  await drawer().getByTitle("Delete", { exact: true }).click();
  await dialogHandled;
  assert.equal(
    confirmMessage,
    `Delete ${beadId}? This calls ${expectedTracker} delete.`,
    `${label}: delete confirmation names ${expectedTracker}`,
  );

  step = `${label}: close reason note`;
  await drawer().locator("select").first().selectOption("closed");
  const closeNote = drawer().locator("span", { hasText: /attach a reason later/ });
  await closeNote.waitFor();
  const noteText = (await closeNote.innerText()).trim();
  assert.match(
    noteText,
    new RegExp(`^${expectedTracker} can['’]t attach a reason later`),
    `${label}: close reason note starts with "${expectedTracker} can't", got ${JSON.stringify(noteText)}`,
  );
  await drawer().getByRole("button", { name: "Cancel", exact: true }).click();
}

async function closeScenario({ context, state }) {
  assert.deepEqual(state.nonGet, [], `${step}: no write request left the page`);
  assert.deepEqual(state.unexpected, [], `${step}: no unexpected API request`);
  await context.close();
}

try {
  // 1. Launcher card for the merged page.
  step = "launcher card";
  let scenario = await openScenario("/");
  const allCard = page.getByRole("button", { name: /^All projects/ });
  await allCard.waitFor();
  const cardText = await allCard.innerText();
  assert.match(
    cardText,
    /Edit, move and create beads in any of them\./,
    `launcher card has the new sentence: ${JSON.stringify(cardText)}`,
  );
  assert.doesNotMatch(cardText, /read-only/i, `launcher card does not say Read-only: ${JSON.stringify(cardText)}`);
  await closeScenario(scenario);

  // 2. Single br project: absent meta (while loading), board subtitle, switcher (offline + live),
  //    create hint, delete confirm, close-reason note.
  step = "br project (offline stream + absent meta)";
  scenario = await openScenario("/p/alpha?view=board", { liveStream: false, holdBeads: true });
  await boardSubtitle().waitFor();
  const loadingSub = (await boardSubtitle().innerText()).trim();
  assert.doesNotMatch(
    loadingSub,
    /\b(bd|br)\b/,
    `board subtitle names no tracker while meta is absent: ${JSON.stringify(loadingSub)}`,
  );
  scenario.state.releaseBeads();
  await card("ab-1").waitFor();
  await waitForViewerMode(scenario.state);

  const brSub = (await boardSubtitle().innerText()).trim();
  assert.match(brSub, /live from br$/, `br board subtitle ends in "live from br": ${JSON.stringify(brSub)}`);
  assert.doesNotMatch(brSub, /\bbd\b/, `br board subtitle does not mention bd: ${JSON.stringify(brSub)}`);

  const brOfflineLine = (await switcherSubline("Alpha App").innerText()).trim();
  assert.equal(brOfflineLine, "project", `br switcher subline offline is "project", got ${JSON.stringify(brOfflineLine)}`);

  await page.getByRole("button", { name: "New", exact: true }).click();
  assert.equal(await readCreateHint(), "br create … --json", "br create hint names br");
  await createDialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await createDialog().waitFor({ state: "detached" });

  await card("ab-1").click();
  await drawer().getByRole("heading", { name: "Alpha one", exact: true }).waitFor();
  await checkDrawerTexts("br project", "ab-1", "br");
  await closeScenario(scenario);

  step = "br project (live stream)";
  scenario = await openScenario("/p/alpha?view=board", { liveStream: true });
  await card("ab-1").waitFor();
  await page.locator('button[aria-label="Select project, current project Alpha App"] span[title^="Live"]').first().waitFor();
  const brLiveLine = (await switcherSubline("Alpha App").innerText()).trim();
  assert.equal(brLiveLine, "live", `br switcher subline live is "live", got ${JSON.stringify(brLiveLine)}`);
  await closeScenario(scenario);

  // 3. Single bd project: board subtitle, switcher (offline + live), create hint, delete confirm,
  //    close-reason note.
  step = "bd project (offline stream)";
  scenario = await openScenario("/p/beta?view=board", { liveStream: false });
  await card("ab-1").waitFor();
  await waitForViewerMode(scenario.state);

  const bdSub = (await boardSubtitle().innerText()).trim();
  assert.match(bdSub, /live from bd list$/, `bd board subtitle ends in "live from bd list": ${JSON.stringify(bdSub)}`);

  const bdOfflineLine = (await switcherSubline("Beta Tools").innerText()).trim();
  assert.equal(bdOfflineLine, "project", `bd switcher subline offline is "project", got ${JSON.stringify(bdOfflineLine)}`);

  await page.getByRole("button", { name: "New", exact: true }).click();
  assert.equal(await readCreateHint(), "bd create … --json", "bd create hint names bd");
  await createDialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await createDialog().waitFor({ state: "detached" });

  await card("ab-1").click();
  await drawer().getByRole("heading", { name: "Beta one", exact: true }).waitFor();
  await checkDrawerTexts("bd project", "ab-1", "bd");
  await closeScenario(scenario);

  step = "bd project (live stream)";
  scenario = await openScenario("/p/beta?view=board", { liveStream: true });
  await card("ab-1").waitFor();
  await page.locator('button[aria-label="Select project, current project Beta Tools"] span[title^="Live"]').first().waitFor();
  const bdLiveLine = (await switcherSubline("Beta Tools").innerText()).trim();
  assert.equal(bdLiveLine, "live", `bd switcher subline live is "live", got ${JSON.stringify(bdLiveLine)}`);
  await closeScenario(scenario);

  // 4. Merged all-projects page: board subtitle, plus panel and create form for both br and bd.
  step = "merged page";
  scenario = await openScenario("/all");
  await card("alpha:ab-1").waitFor();
  await card("beta:ab-1").waitFor();
  await waitForViewerMode(scenario.state);

  const allSub = (await boardSubtitle().innerText()).trim();
  assert.match(
    allSub,
    /live from every project$/,
    `merged board subtitle ends in "live from every project": ${JSON.stringify(allSub)}`,
  );
  assert.doesNotMatch(
    allSub,
    /\b(bd|br)\b/,
    `merged board subtitle names no tracker: ${JSON.stringify(allSub)}`,
  );

  // Create form from the merged page's New button for br and bd projects.
  for (const [project, expected] of [
    [alpha, "br"],
    [beta, "bd"],
  ]) {
    step = `merged page create (${expected})`;
    await page.getByRole("button", { name: "New", exact: true }).click();
    await chooser().waitFor();
    await chooser().getByRole("button", { name: project.name, exact: true }).click();
    assert.equal(
      await readCreateHint(),
      `${expected} create … --json`,
      `merged page create form for ${project.id} names ${expected}`,
    );
    await createDialog().getByRole("button", { name: "Cancel", exact: true }).click();
    await createDialog().waitFor({ state: "detached" });
  }

  // Detail panel + Add subtask create form from the merged page for br and bd projects.
  for (const [project, title, expected] of [
    [alpha, "Alpha one", "br"],
    [beta, "Beta one", "bd"],
  ]) {
    step = `merged page panel (${expected})`;
    await card(`${project.id}:ab-1`).click();
    await drawer().getByRole("heading", { name: title, exact: true }).waitFor();
    await checkDrawerTexts(`merged page ${expected} panel`, "ab-1", expected);

    await drawer().getByRole("button", { name: "Add subtask" }).click();
    assert.equal(
      await readCreateHint(),
      `${expected} create … --json`,
      `merged page Add subtask for ${project.id} names ${expected}`,
    );
    await createDialog().getByRole("button", { name: "Cancel", exact: true }).click();
    await createDialog().waitFor({ state: "detached" });

    await drawer().getByTitle("Close", { exact: true }).click();
    await drawer().waitFor({ state: "hidden" });
  }
  await closeScenario(scenario);

  console.log("PASS: all six tracker texts match launcher, br, bd, absent meta, and merged /all contexts");
} catch (error) {
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ step, url: page?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  for (const res of openStreams) res.end();
  sseServer.close();
  await browser.close();
}
