// A sprint opens on the board of every project from the sprints listing, and the page it opens
// says which sprint it is showing: a bar with the sprint's name, dates, state and points, a way
// back to the sprint, and a button that leaves the sprint view. The view is the page at /all with
// its label filter holding that one sprint's label, so the board and the list are the usual ones.
// Every /api/ response comes from fixtures through page.route, which also records each request.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const beta = { id: "beta", name: "Beta Tools", kind: "br" };
const PROJECTS = [alpha, beta];
const META = { humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 };
const PLAN = "2026-11-23";
const LABEL = `sprint:${PLAN}`;
const VIEW = `/all?label=sprint%3A${PLAN}&done=all`;

function sprint(start, name, state, capacity = 20) {
  return {
    id: start, name, start, end: start.replace(/-\d\d$/, "-28"), capacity, state,
    createdAt: T, startedAt: null, closedAt: null, planned: null,
    unreadableAtStart: [], summary: null, pending: [],
  };
}
const SPRINTS = [
  sprint(PLAN, "Plan A", "planned"),
  sprint("2026-11-16", "Running", "active"),
  sprint("2026-11-09", "Wrapping", "closing"),
  sprint("2026-10-05", "Old one", "closed"),
];

const own = (id, title, extra = {}) => ({
  id, title, description: "", status: "open", priority: 2, issue_type: "task", assignee: "",
  labels: [], comments: [], dependencies: [], created_by: "reviewer", created_at: T, updated_at: T,
  ...extra,
});
// Three beads of two projects carry the sprint's label, one of them closed: 2 + 3 + 0 points.
// A sized bead outside the sprint keeps those points apart from the points of everything.
const seed = () => ({
  alpha: [
    own("a-1", "Alpha in sprint", { labels: [LABEL, "size:M"] }),
    own("a-2", "Alpha done in sprint", { labels: [LABEL, "size:L"], status: "closed", closed_at: T }),
    own("a-3", "Alpha outside", { labels: ["size:XL"] }),
    own("e-1", "Alpha epic", { issue_type: "epic" }),
  ],
  beta: [
    own("b-1", "Beta in sprint", { labels: [LABEL] }),
    own("b-2", "Beta in another sprint", { labels: ["sprint:2026-11-16", "keep"] }),
  ],
});

// The merged form, the way lib/aggregate.ts namespaces a bead.
const merged = (project, bead) => ({
  ...structuredClone(bead),
  id: `${project.id}:${bead.id}`,
  local_id: bead.id,
  project: { id: project.id, name: project.name },
});

const browser = await chromium.launch();
let page;
let state;
// Named in the failure report: a wait that times out says only TimeoutError.
let step = "start";

async function openScenario(url, { readOnly = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  state = { beads: seed(), requests: [], writes: [], sprintReads: 0, viewerAnswers: 0 };
  const s = state;
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    s.requests.push({ method, path: pathname });
    const status = pathname.match(/^\/api\/p\/([^/]+)\/beads\/([^/]+)\/status$/);
    if (method === "POST" && status) {
      const body = JSON.parse(request.postData() ?? "{}");
      s.writes.push({ projectId: status[1], own: status[2], body });
      const bead = s.beads[status[1]].find((b) => b.id === status[2]);
      bead.status = body.status;
      return route.fulfill({ json: structuredClone(bead) });
    }
    if (method !== "GET") return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${pathname}` } });
    if (pathname === "/api/viewer-mode") {
      s.viewerAnswers += 1;
      return route.fulfill({ json: { readOnly } });
    }
    if (pathname === "/api/projects") {
      return route.fulfill({ json: { projects: PROJECTS.map((p) => ({ id: p.id, name: p.name, path: null, hasBeads: true })) } });
    }
    if (pathname === "/api/sprints") {
      s.sprintReads += 1;
      return route.fulfill({ json: { sprints: SPRINTS } });
    }
    if (pathname === "/api/all/beads") {
      return route.fulfill({
        json: {
          beads: PROJECTS.flatMap((p) => s.beads[p.id].map((b) => merged(p, b))),
          meta: { kind: "all", readOnly, ...META, projects: PROJECTS.map((p) => ({ ...p, count: s.beads[p.id].length })), failed: [] },
        },
      });
    }
    if (pathname.endsWith("/beads/stream")) return route.abort();
    if (pathname.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}${url}`);
  return context;
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
const cardIds = async () => (await page.locator("[data-keyboard-bead-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-keyboard-bead-id")))).sort();
const columnOf = (id) => card(id).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
const bar = () => page.getByTestId("sprint-board-bar");
// The word "Sprint" is set in capitals by the style sheet, and innerText reports it that way.
const barText = async () => (await bar().innerText()).replace(/\s+/g, " ").trim().replace(/^SPRINT /, "Sprint ");
const boardLink = (name) => page.getByRole("link", { name: `Open ${name} on the board`, exact: true });
const viewButton = (name) => page.locator("aside nav").getByRole("button", { name: new RegExp(`^${name}`) });
const params = () => new URL(page.url()).searchParams;
const IN_SPRINT = ["alpha:a-1", "alpha:a-2", "beta:b-1"];

// Cards slide to their new places after a drop, so a position is read once it has stopped moving.
async function centerOf(locator) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    const box = await locator.boundingBox();
    if (box && last && Math.abs(box.x - last.x) < 0.5 && Math.abs(box.y - last.y) < 0.5) {
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    last = box;
    await page.waitForTimeout(50);
  }
  assert.fail(`${step}: the drag ends are on screen and still`);
}

// Low in a column's own drop zone, where no card is, so the column itself is under the pointer.
async function dropPoint(name) {
  const point = await page.evaluate((columnName) => {
    for (const section of document.querySelectorAll("section")) {
      if (section.querySelector("span.font-semibold")?.textContent !== columnName) continue;
      const zone = section.children[1].getBoundingClientRect();
      return { x: zone.x + zone.width / 2, y: zone.y + zone.height - 40 };
    }
    return null;
  }, name);
  assert.ok(point, `${step}: the ${name} column is on the board`);
  return point;
}

// A real drag: press, move a little so the sensor starts it, travel in steps, then release.
async function dragTo(id, point) {
  const from = await centerOf(card(id));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
  await eventually(async () => (await card(id).evaluate((el) => getComputedStyle(el).opacity)) === "0.4", `${id} is being dragged`);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

try {
  step = "links in the listing";
  let context = await openScenario("/sprints", { readOnly: true });
  await page.getByTestId("sprint-row").first().waitFor();
  for (const s of SPRINTS) {
    assert.equal(await boardLink(s.name).innerText(), "Board", `${s.name} (${s.state}) has a Board link`);
    assert.equal(await boardLink(s.name).getAttribute("href"), `/all?label=sprint%3A${s.id}&done=all`, `${s.name}: the address of its sprint view`);
  }
  const listed = (await page.getByTestId("sprint-row").filter({ hasText: "Plan A" }).innerText()).match(/\d+ \/ \d+ points/)?.[0];
  assert.equal(listed, "5 / 20 points", "the listing counts the sprint's points");
  await context.close();

  step = "from the listing to the board";
  context = await openScenario("/sprints");
  await boardLink("Plan A").click();
  await page.waitForURL((url) => url.pathname === "/all");
  assert.deepEqual(params().getAll("label"), [LABEL]);
  assert.equal(params().get("done"), "all");

  step = "the bar";
  await bar().waitFor();
  await card("alpha:a-1").waitFor();
  await eventually(async () => (await barText()).includes(listed), "the bar shows the listing's two numbers");
  assert.equal(await barText(), `Sprint Plan A ${PLAN} to 2026-11-28 planned ${listed} ← Back to sprint Leave sprint view`);
  assert.equal(await bar().getByRole("link", { name: "← Back to sprint", exact: true }).getAttribute("href"), `/sprints/${PLAN}`);

  step = "the board holds the sprint";
  assert.deepEqual(await cardIds(), IN_SPRINT, "exactly the beads carrying the label, of every project");
  assert.equal(await columnOf("alpha:a-2"), "Done", "a closed bead of the sprint is in the Done column");
  assert.equal(await columnOf("alpha:a-1"), "Ready");

  step = "the list holds the sprint";
  await viewButton("List").click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  await card("beta:b-1").waitFor();
  assert.deepEqual(await cardIds(), IN_SPRINT, "the list shows the same beads");
  assert.equal(await bar().count(), 1, "the bar stays on the list");

  step = "the epics view is no sprint view";
  await viewButton("Epics").click();
  await page.locator('[data-epic-id="alpha:e-1"]').waitFor();
  assert.equal(await bar().count(), 0, "no bar where the filter is not applied");
  await viewButton("Board").click();
  await bar().waitFor();
  await card("alpha:a-1").waitFor();

  step = "a drag on the sprint's board";
  await eventually(() => state.viewerAnswers > 0, "the viewer mode answered");
  await page.getByRole("button", { name: /^New/ }).first().waitFor();
  await dragTo("alpha:a-1", await dropPoint("In Progress"));
  await eventually(() => state.writes.length === 1, "the drop was written");
  assert.deepEqual(state.writes, [{ projectId: "alpha", own: "a-1", body: { status: "in_progress" } }], "one status write, to the bead's own project and id");
  await eventually(async () => (await columnOf("alpha:a-1")) === "In Progress", "the card is in its new column");
  assert.deepEqual(await cardIds(), IN_SPRINT, "and still on the sprint's board");
  await context.close();

  step = "leaving the sprint view";
  context = await openScenario(`${VIEW}&type=task`);
  await bar().waitFor();
  await card("alpha:a-1").waitFor();
  await bar().getByRole("button", { name: "Leave sprint view", exact: true }).click();
  await bar().waitFor({ state: "detached" });
  assert.equal(params().has("label"), false, "the label is gone from the address");
  assert.equal(params().has("done"), false, "and so is the done window it came with");
  assert.deepEqual(params().getAll("type"), ["task"], "every other parameter is kept");
  await card("alpha:a-3").waitFor();
  assert.equal(await card("beta:b-2").count(), 1, "the board shows beads outside the sprint again");
  await context.close();

  step = "no bar without a sprint view";
  context = await openScenario("/all");
  await card("alpha:a-3").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await bar().count(), 0, "no label, no bar");
  assert.equal(state.sprintReads, 0, "and the sprints were not asked for");
  await context.close();

  context = await openScenario(`/all?label=sprint%3A${PLAN}&label=keep&done=all`);
  await card("beta:b-2").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await bar().count(), 0, "a second label beside the sprint's: no bar");
  assert.equal(state.sprintReads, 0, "and the sprints were not asked for");
  await context.close();

  context = await openScenario("/all?label=sprint%3A1999-01-01&done=all");
  await eventually(() => state.sprintReads > 0, "a sprint label has to be looked up");
  await page.getByRole("heading", { name: "All projects", exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await bar().count(), 0, "a label that matches no sprint: no bar");
  await context.close();

  step = "read-only viewer mode";
  context = await openScenario(VIEW, { readOnly: true });
  await bar().waitFor();
  await card("alpha:a-1").waitFor();
  await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();
  assert.equal(await bar().getByRole("link", { name: "← Back to sprint", exact: true }).count(), 1, "the way back is there");
  assert.equal(await bar().getByRole("button", { name: "Leave sprint view", exact: true }).isEnabled(), true, "leaving writes nothing, so it works");
  assert.deepEqual(state.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`), [], "nothing but GET");
  await context.close();

  console.log("PASS sprint board: links in the listing, the bar, the sprint's beads on board and list, a drag, leaving, no bar without a sprint view, read-only");
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
