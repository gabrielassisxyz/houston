// The all-projects page at /all: one board, list and epics view over the merged list, read-only
// under a read-only viewer mode, with the ordinary drawer opened under the bead's own project. The
// merged list and its stream are answered from fixtures through page.route, so no tracker is read
// or written. What the page writes in editing mode is test-all-page-writes.mjs's to check.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const dep = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

// Builds a merged-list bead the way lib/aggregate.ts namespaces it.
function merged(project, local, fields = {}) {
  const id = `${project.id}:${local}`;
  const dependencies = (fields.deps ?? []).map(([to, type]) => dep(id, `${project.id}:${to}`, type));
  return {
    id,
    local_id: local,
    project,
    title: fields.title,
    description: fields.description ?? "",
    status: fields.status ?? "open",
    priority: fields.priority ?? 2,
    issue_type: fields.type ?? "task",
    labels: fields.labels ?? [],
    comments: [],
    dependencies,
    created_at: T,
    updated_at: fields.updated_at ?? T,
    ...(fields.parent ? { parent: `${project.id}:${fields.parent}` } : {}),
  };
}

const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };
const brokenProject = { id: "gamma", name: "Gamma Broken", error: "tracker unreadable" };

const baseBeads = () => [
  merged(alpha, "a-1", { title: "Alpha ready", deps: [["a-2", "related"]], labels: ["keep"], description: "- [ ] step one" }),
  merged(alpha, "a-2", { title: "Alpha in progress", status: "in_progress" }),
  merged(alpha, "a-4", { title: "Alpha blocked", deps: [["a-2", "blocks"]] }),
  merged(alpha, "e-1", { title: "Alpha epic", type: "epic" }),
  merged(alpha, "a-5", { title: "Alpha child", parent: "e-1", deps: [["e-1", "parent-child"]] }),
  merged(alpha, "a-6", { title: "Alpha unblocked", deps: [["a-7", "blocks"]] }),
  merged(alpha, "a-7", { title: "Alpha finished", status: "closed" }),
  merged(beta, "a-1", { title: "Beta twin of a-1", status: "deferred" }),
  merged(beta, "b-2", { title: "Beta done", status: "closed" }),
];

const COLUMN_OF = {
  "alpha:a-1": "Ready",
  "alpha:a-2": "In Progress",
  "alpha:a-4": "Blocked",
  "alpha:a-5": "Ready",
  "alpha:a-6": "Ready",
  "beta:a-1": "Backlog",
};

// The page opens with Done hidden, so the closed beads of the fixture are not on screen.
const CLOSED = ["alpha:a-7", "beta:b-2"];

function metaFor(failed) {
  return {
    kind: "all",
    readOnly: true,
    humanActor: "reviewer",
    humanAllowlist: ["reviewer"],
    pollIntervalMs: 300_000,
    projects: [
      { ...alpha, kind: "br", count: 7 },
      { ...beta, kind: "bd", count: 2 },
    ],
    failed,
  };
}

const allRequests = [];
const writesSent = [];
const browser = await chromium.launch();
let page;

// One page per scenario, each with its own fixture state and stream counters.
async function openScenario(url, { failed = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("request", (r) => allRequests.push({ method: r.method(), url: r.url() }));

  const state = {
    beads: baseBeads(),
    failed,
    listGets: 0,
    streamOpens: 0,
    changesSent: 0,
    pendingChange: false,
    unrouted: [],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/all/beads/stream") {
      state.streamOpens += 1;
      // A finished response makes EventSource reconnect after `retry`, so a change is
      // delivered only on the reconnect that follows the test setting the flag.
      let body = "retry: 200\n: connected\n\n";
      if (state.pendingChange) {
        state.pendingChange = false;
        state.changesSent += 1;
        body += "event: change\ndata: {}\n\n";
      }
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body,
      });
    }
    // The page follows the viewer mode, so the read-only this script checks is stated, not assumed.
    if (path === "/api/viewer-mode" && request.method() === "GET") return route.fulfill({ json: { readOnly: true } });
    // A write answered with 200 would look as if it had worked; it is recorded and refused instead.
    if (request.method() !== "GET") {
      writesSent.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "read-only" } });
    }
    if (path === "/api/all/beads") {
      state.listGets += 1;
      return route.fulfill({ json: { beads: state.beads, meta: metaFor(state.failed) } });
    }
    if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
    if (path === "/api/capabilities") {
      return route.fulfill({ json: { workDashboardUrl: null, chain: false, notes: false, obsidianVault: null } });
    }
    state.unrouted.push(path);
    return route.fulfill({ json: {} });
  });

  await page.goto(`${base}${url}`);
  return { context, state };
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const drawer = () => page.getByRole("dialog");
const beadParam = () => new URL(page.url()).searchParams.get("bead");
// The page is read-only until the viewer mode answers, so a control checked before the banner
// shows would be absent for the wrong reason.
const readOnlyShown = () => page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();

async function columnOf(id) {
  return card(id).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
}

async function checkBoard() {
  for (const [id, column] of Object.entries(COLUMN_OF)) {
    await card(id).waitFor();
    assert.equal(await columnOf(id), column, `${id} sits in ${column}`);
  }
  assert.equal(await page.locator("[data-keyboard-bead-id]").count(), 6, "one card per open task, no more (the epic has its own view)");
  for (const id of CLOSED) assert.equal(await card(id).count(), 0, `${id} is closed and hidden by default`);
  assert.equal(
    await page.getByRole("combobox", { name: "Done window" }).locator("option:checked").innerText(),
    "Hidden",
    "the Done column's selector reads Hidden",
  );
}

try {
  // Board over two projects, equal original ids as two cards, the fallback for an unknown view.
  let scenario = await openScenario("/all");
  await checkBoard();
  assert.equal(await card("alpha:a-1").count(), 1);
  assert.equal(await card("beta:a-1").count(), 1);
  assert.equal(await page.getByText("Alpha ready", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Beta twin of a-1", { exact: true }).count(), 1);
  await scenario.context.close();

  scenario = await openScenario("/all?view=insights");
  await checkBoard();
  assert.equal(await page.locator("aside nav").getByRole("button", { name: /^Board/ }).getAttribute("aria-current"), "page");
  await scenario.context.close();

  // List and epics over the same beads.
  scenario = await openScenario("/all?view=list");
  await card("alpha:a-1").waitFor();
  await card("beta:a-1").waitFor();
  assert.equal(await page.locator("[data-epic-id]").count(), 0, "the list is not the epics view");
  assert.equal(await page.locator("aside nav").getByRole("button", { name: /^List/ }).getAttribute("aria-current"), "page");
  assert.equal(await page.getByText("Backlog", { exact: true }).count() > 0, true, "list groups by column");
  await readOnlyShown();
  assert.equal(await page.getByRole("button", { name: /^New/ }).count(), 0, "list offers no New button");
  await scenario.context.close();

  scenario = await openScenario("/all?view=epics");
  await page.locator('[data-epic-id="alpha:e-1"]').waitFor();
  assert.equal(await page.locator("aside nav").getByRole("button", { name: /^Epics/ }).getAttribute("aria-current"), "page");
  assert.equal(await page.locator("[data-epic-id]").count(), 1, "one epic in the fixture");
  await scenario.context.close();

  // Switching views keeps the rest of the address, as a project's page does.
  scenario = await openScenario("/all?status=in_progress");
  await card("alpha:a-2").waitFor();
  await page.locator("aside nav").getByRole("button", { name: /^List/ }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  assert.deepEqual(new URL(page.url()).searchParams.getAll("status"), ["in_progress"], "switching views keeps the filters");
  await card("alpha:a-2").waitFor();
  assert.equal(await card("alpha:a-1").count(), 0, "the list is still narrowed");
  await scenario.context.close();

  // A row's epic opens the epics view with that epic, from another view.
  scenario = await openScenario("/all?view=list");
  await card("alpha:a-5").locator('button[title^="e-1 · Alpha epic"]').click();
  await page.waitForURL((url) => url.searchParams.get("view") === "epics");
  await page.locator('[data-epic-id="alpha:e-1"]').waitFor();
  await card("alpha:a-5").waitFor();
  await scenario.context.close();

  // Board under the read-only mode: no New button, and a real mouse drag of a card changes nothing.
  scenario = await openScenario("/all");
  await checkBoard();
  await readOnlyShown();
  assert.equal(await page.getByRole("button", { name: /^New/ }).count(), 0, "board offers no New button");
  const source = await card("alpha:a-1").boundingBox();
  const doneColumn = await page.locator("section", { hasText: "Done" }).first().boundingBox();
  assert.ok(source && doneColumn, "both drag ends are on screen");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 40, source.y + 40, { steps: 5 });
  await page.mouse.move(doneColumn.x + doneColumn.width / 2, doneColumn.y + 160, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(await columnOf("alpha:a-1"), "Ready", "the dragged card did not move");
  await scenario.context.close();

  // Drawer: URL, original id, reload, dependency hop, browser back, copy-link.
  scenario = await openScenario("/all");
  await readOnlyShown();
  await card("alpha:a-1").click();
  await drawer().getByRole("heading", { name: "Alpha ready" }).waitFor();
  assert.equal(beadParam(), "alpha:a-1", "the URL names the namespaced id");
  const shown = await drawer().innerText();
  assert.match(shown, /\ba-1\b/, "the drawer shows the original id");
  assert.ok(!shown.includes("alpha:a-1"), "the drawer never shows the namespaced id");
  const selects = drawer().locator("select");
  assert.ok((await selects.count()) >= 2, "status and priority selects are present");
  for (let i = 0; i < (await selects.count()); i++) {
    assert.equal(await selects.nth(i).isDisabled(), true, `drawer select ${i} is disabled`);
  }
  // What else looks editable is inert too; the final check on requests is what judges these clicks.
  const labelControls = drawer().locator("fieldset button");
  assert.ok((await labelControls.count()) > 0, "the opened bead has a label with a remove control");
  await labelControls.first().click({ force: true });
  const tasks = drawer().locator('input[type="checkbox"]');
  assert.ok((await tasks.count()) > 0, "the opened bead's description has a task checkbox");
  await tasks.first().click({ force: true });
  await page.waitForTimeout(300);

  await drawer().getByTitle("Copy link").click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes("/p/"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/p/alpha?bead=a-1`);

  await page.reload();
  await drawer().getByRole("heading", { name: "Alpha ready" }).waitFor();
  assert.equal(beadParam(), "alpha:a-1", "reloading keeps the bead open");

  await drawer().locator('button[title="Open a-2"]').click();
  await drawer().getByRole("heading", { name: "Alpha in progress" }).waitFor();
  assert.equal(beadParam(), "alpha:a-2", "the dependency opened the target of the same project");
  await page.goBack();
  await drawer().getByRole("heading", { name: "Alpha ready" }).waitFor();
  assert.equal(beadParam(), "alpha:a-1", "the browser's back button returned to the first bead");
  await page.keyboard.press("Escape");
  await drawer().waitFor({ state: "hidden" });
  assert.equal(beadParam(), null, "closing removes the parameter");

  // The twin with the same original id opens under its own project.
  await card("beta:a-1").click();
  await drawer().getByRole("heading", { name: "Beta twin of a-1" }).waitFor();
  assert.equal(beadParam(), "beta:a-1");
  await drawer().getByTitle("Copy link").click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes("/p/beta"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/p/beta?bead=a-1`);
  await scenario.context.close();

  // A bead that is not in the merged list opens nothing and says so.
  scenario = await openScenario("/all?bead=alpha:gone");
  await page.getByText("Bead alpha:gone not found in any project").waitFor();
  assert.equal(await drawer().count(), 0, "no drawer for a missing bead");
  await scenario.context.close();

  // A bead of a project that could not be read gets its own message.
  scenario = await openScenario("/all?bead=gamma:g-1", { failed: [brokenProject] });
  await page.getByText("Bead g-1 belongs to Gamma Broken, which could not be read").waitFor();
  await scenario.context.close();

  // The failed-project notice names the project and goes when a later response has none.
  scenario = await openScenario("/all", { failed: [brokenProject] });
  const notice = page.getByRole("alert").filter({ hasText: "Gamma Broken" });
  await notice.waitFor();
  assert.match(await notice.innerText(), /Gamma Broken/);
  await checkBoard();
  const { state } = scenario;

  // The stream: reconnects alone cause no refetch; one delivered change causes exactly one.
  const settled = state.listGets;
  await page.waitForTimeout(1500);
  assert.ok(state.streamOpens >= 3, `the stream reconnected on its own (${state.streamOpens})`);
  assert.equal(state.changesSent, 0, "no change has been delivered yet");
  assert.equal(state.listGets, settled, "reconnecting alone did not refetch");

  state.failed = [];
  state.beads = [...state.beads, merged(alpha, "a-9", { title: "Alpha fresh" })];
  state.pendingChange = true;
  await card("alpha:a-9").waitFor();
  assert.equal(state.changesSent, 1, "the stream delivered one change event to the page");
  await notice.waitFor({ state: "hidden" });
  await page.waitForTimeout(600);
  assert.equal(state.listGets, settled + 1, "one change event caused exactly one new GET /api/all/beads");
  await scenario.context.close();

  // Nothing but GET left any page.
  const nonGet = allRequests.filter((r) => r.method !== "GET");
  assert.deepEqual(nonGet, [], "no request other than GET left the page");
  assert.deepEqual(writesSent, [], "the fixtures received no write");
  assert.ok(allRequests.some((r) => r.method === "GET" && r.url.includes("/api/all/beads")), "the page did fetch");

  console.log(
    `PASS: /all shows both projects on board, list and epics, read-only under a read-only viewer mode, ` +
      `drawer under the bead's own project, ` +
      `refetch on a stream change; ${allRequests.length} requests, ${nonGet.length} non-GET`,
  );
} catch (error) {
  // The scenario's context may already be closed when a final assertion fails.
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
