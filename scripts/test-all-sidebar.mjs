// The page over every project at /all carries the sidebar a project's page has, in the form that
// fits a page with no project of its own: three views, the project switcher naming "All
// projects", the same footer, and the same sheet on a narrow screen. Its header keeps only the
// title. Every /api/ response comes from fixtures through page.route, which also records each
// request so the test can say what the page asked for.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const beta = { id: "beta", name: "Beta Tools", kind: "br" };
const PROJECTS = [alpha, beta];
const META = { humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 };
const GONE = ["Focus", "Graph", "Insights", "Activity", "Needs You", "Achievements", "Publish", "Settings"];
const SWITCHER = "Select project, current project All projects";

const own = (id, title, extra = {}) => ({
  id, title, description: "", status: "open", priority: 2, issue_type: "task", assignee: "",
  labels: [], comments: [], dependencies: [], created_by: "reviewer", created_at: T, updated_at: T,
  ...extra,
});
const BEADS = {
  alpha: [own("a-1", "Alpha ready"), own("a-2", "Alpha moving", { status: "in_progress" }), own("e-1", "Alpha epic", { issue_type: "epic" })],
  beta: [own("b-1", "Beta ready"), own("e-2", "Beta epic", { issue_type: "epic" })],
};

// The merged form, the way lib/aggregate.ts namespaces a bead.
const merged = (project, bead) => ({
  ...structuredClone(bead),
  id: `${project.id}:${bead.id}`,
  local_id: bead.id,
  project: { id: project.id, name: project.name },
});

const browser = await chromium.launch();
let page;
// Named in the failure report: a wait that times out says only TimeoutError.
let step = "start";

async function openScenario(url, { width = 1500, readOnly = false, storedWidth, configured = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  if (storedWidth) {
    await context.addInitScript((value) => window.localStorage.setItem("bmus.width.sidebar", value), String(storedWidth));
  }
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const state = { requests: [], viewerAnswers: 0, capsAnswers: 0 };
  const workUrl = "http://127.0.0.1:9/painel-do-trabalho";
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.requests.push({ method: request.method(), path, from: new URL(page.url()).pathname });
    if (path === "/api/work/probe") {
      if (configured) return route.fulfill({ json: { configured: true, reachable: false } });
      return route.fulfill({ status: 500, json: { error: `unexpected ${request.method()} ${path}` } });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: `unexpected ${request.method()} ${path}` } });
    if (path === "/api/capabilities") {
      state.capsAnswers += 1;
      return route.fulfill({ json: { workDashboardUrl: configured ? workUrl : null } });
    }
    if (path === "/api/viewer-mode") {
      state.viewerAnswers += 1;
      return route.fulfill({ json: { readOnly } });
    }
    if (path === "/api/projects") {
      return route.fulfill({ json: { projects: PROJECTS.map((p) => ({ id: p.id, name: p.name, path: null, hasBeads: true })) } });
    }
    if (path === "/api/all/beads") {
      return route.fulfill({
        json: {
          beads: PROJECTS.flatMap((p) => BEADS[p.id].map((b) => merged(p, b))),
          meta: { kind: "all", readOnly, ...META, projects: PROJECTS.map((p) => ({ ...p, count: BEADS[p.id].length })), failed: [] },
        },
      });
    }
    if (path.endsWith("/beads/stream")) return route.abort();
    const ownList = path.match(/^\/api\/p\/([^/]+)\/beads$/);
    if (ownList) return route.fulfill({ json: { beads: structuredClone(BEADS[ownList[1]] ?? []), meta: { kind: "br", ...META } } });
    if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
    if (path.endsWith("/activity")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}${url}`);
  return { context, state };
}

async function eventually(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`${step}: ${label}${last ? ` (${last.message})` : ""}`);
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const aside = () => page.locator("aside");
const nav = () => aside().locator("nav");
const viewButton = (name) => nav().getByRole("button", { name: new RegExp(`^${name}`) });
const asideWidth = async () => Math.round((await aside().boundingBox()).width);
const params = () => new URL(page.url()).searchParams;
const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });

async function openSwitcher() {
  await page.getByRole("button", { name: SWITCHER, exact: true }).click();
  await menuItem("Project picker").waitFor();
}

// What the page asked for while it was the page over every project.
function fromAll(state) {
  return state.requests.filter((r) => r.from === "/all");
}

function checkRequests(state, label) {
  const sent = fromAll(state);
  assert.ok(sent.some((r) => r.path === "/api/all/beads"), `${label}: the merged list was read`);
  assert.deepEqual(sent.filter((r) => /(@|%40)all/i.test(r.path)).map((r) => r.path), [], `${label}: nothing addressed to the pseudo project`);
  assert.deepEqual(sent.filter((r) => r.path.includes("gamification")).map((r) => r.path), [], `${label}: no gamification read`);
  assert.deepEqual(sent.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`), [], `${label}: nothing but GET`);
}

try {
  step = "desktop sidebar";
  let scenario = await openScenario("/all");
  await card("alpha:a-1").waitFor();
  assert.equal(await aside().count(), 1, "exactly one sidebar");
  assert.equal(await aside().isVisible(), true, "the sidebar is on screen");
  assert.equal(await asideWidth(), 228, "default width");
  await aside().getByText("Houston", { exact: true }).waitFor();

  step = "nav entries";
  assert.deepEqual(
    (await nav().getByRole("button").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["Board", "List", "Epics 2"],
    "three views in order, with the epics of every project counted",
  );
  for (const name of GONE) {
    assert.equal(await nav().getByRole("button", { name, exact: true }).count(), 0, `no ${name} entry over every project`);
  }
  assert.equal(await viewButton("Board").getAttribute("aria-current"), "page", "the board is the view on screen");
  assert.equal(await viewButton("List").getAttribute("aria-current"), null);

  step = "reduced header";
  await page.getByRole("heading", { name: "All projects", exact: true }).waitFor();
  for (const name of ["Board", "List", "Epics", "Sprints", "← Back to projects"]) {
    assert.equal(await page.getByRole("link", { name, exact: true }).count(), 0, `the header has no ${name} link`);
  }

  step = "footer";
  await aside().getByText("reviewer", { exact: true }).waitFor();
  await aside().getByText("human actor", { exact: true }).waitFor();
  assert.equal(await aside().getByTitle("Toggle theme").count(), 1, "theme toggle");
  assert.equal(await aside().getByRole("button", { name: /Report \/ request/ }).count(), 0, "no report menu");
  assert.match(await aside().innerText(), /Build /, "build badge");
  assert.doesNotMatch(await aside().innerText(), /Level \d|XP/, "no level card over every project");

  step = "switcher trigger";
  const trigger = page.getByRole("button", { name: SWITCHER, exact: true });
  assert.match((await trigger.innerText()).replace(/\s+/g, " "), /^All projects every project$/, "names the page, not a project");
  assert.equal(await trigger.locator("span.rounded-full").count(), 0, "no live dot");
  checkRequests(scenario.state, "desktop");

  step = "resize";
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 36, y);
  await page.mouse.move(x + 72, y);
  await page.mouse.up();
  assert.equal(await asideWidth(), 300, "dragging widens the sidebar");
  assert.equal(await page.evaluate(() => localStorage.getItem("bmus.width.sidebar")), "300", "stored under the key a project's page uses");
  await scenario.context.close();

  step = "stored width";
  scenario = await openScenario("/all", { storedWidth: 264 });
  await card("alpha:a-1").waitFor();
  await eventually(async () => (await asideWidth()) === 264, "a width saved elsewhere is applied here");
  await scenario.context.close();

  step = "switching views keeps the address";
  scenario = await openScenario("/all?status=in_progress&type=task");
  await card("alpha:a-2").waitFor();
  await viewButton("List").click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  assert.deepEqual(params().getAll("status"), ["in_progress"], "a filter rides along");
  assert.deepEqual(params().getAll("type"), ["task"], "every other parameter rides along");
  await eventually(async () => (await viewButton("List").getAttribute("aria-current")) === "page", "the list is marked as the view on screen");
  assert.equal(await viewButton("Board").getAttribute("aria-current"), null, "and the board no longer is");
  assert.equal(await card("alpha:a-1").count(), 0, "the list is still narrowed");
  await viewButton("Epics").click();
  await page.locator('[data-epic-id="alpha:e-1"]').waitFor();
  assert.equal(params().get("view"), "epics");
  await scenario.context.close();

  step = "switcher menu";
  scenario = await openScenario("/all");
  await card("alpha:a-1").waitFor();
  await openSwitcher();
  const items = (await page.getByRole("menuitem").allInnerTexts()).map((text) => text.trim());
  for (const name of ["Alpha App", "Beta Tools", "Add project…", "All projects", "Sprints", "Project picker"]) {
    assert.ok(items.includes(name), `the menu lists ${name}, saw ${JSON.stringify(items)}`);
  }
  await menuItem("Alpha App").click();
  await page.waitForURL((url) => url.pathname === "/p/alpha");
  await page.goto(`${base}/all`);
  await openSwitcher();
  await menuItem("Sprints").click();
  await page.waitForURL((url) => url.pathname === "/sprints");
  await page.goto(`${base}/all`);
  await openSwitcher();
  await menuItem("Project picker").click();
  await page.waitForURL((url) => url.pathname === "/");
  await scenario.context.close();

  step = "narrow screen";
  scenario = await openScenario("/all", { width: 390 });
  await card("alpha:a-1").waitFor();
  assert.equal(await aside().isVisible(), false, "the sidebar is hidden on a narrow screen");
  await page.getByRole("button", { name: "Open navigation and project menu" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("heading", { name: "Project and view navigation" }).waitFor({ state: "attached" });
  await sheet.getByRole("button", { name: SWITCHER, exact: true }).waitFor();
  assert.deepEqual(
    (await sheet.locator("nav").getByRole("button").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["Board", "List", "Epics 2"],
    "the sheet holds the same three views",
  );
  await sheet.locator("nav").getByRole("button", { name: /^List/ }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  await sheet.waitFor({ state: "hidden" });
  await scenario.context.close();

  step = "read-only viewer mode";
  scenario = await openScenario("/all", { readOnly: true });
  await card("alpha:a-1").waitFor();
  await eventually(() => scenario.state.viewerAnswers > 0, "the viewer mode answered");
  await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();
  assert.equal(await nav().getByRole("button").count(), 3, "the same three views in read-only mode");
  await viewButton("List").click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  await openSwitcher();
  await page.keyboard.press("Escape");
  checkRequests(scenario.state, "read-only");
  await scenario.context.close();

  console.log("PASS all sidebar: entries, header, footer, switcher, resize, narrow screen, read-only, requests");
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
