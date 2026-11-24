// On a project's own page a status being written stays on screen while its write is on its way,
// whatever a read of the project's list brings meanwhile. A tracker changes its files in two
// steps and the page is told at the first, so such a read can still carry the status from before
// the write. Every /api/ response comes from fixtures through page.route: the status write can be
// held and then answered or refused, and it changes the fixture only when it is answered, so a
// list read answered while it is held carries the old status, as the real one does.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const STATUS_PATH = "/api/p/alpha/beads/ab-1/status";
const REFUSED = "Refused by the fixture";

const own = (id, title) => ({
  id, title, description: "", status: "open", priority: 2, issue_type: "task", assignee: "",
  labels: [], comments: [], dependencies: [], created_by: "reviewer", created_at: T, updated_at: T,
});

const browser = await chromium.launch();
let page;
// Named in the failure report: a wait that times out says only TimeoutError.
let step = "start";

const state = {
  beads: [own("ab-1", "Alpha one"), own("ab-2", "Alpha two")],
  viewerAnswers: 0, listAnswered: 0, pendingChange: false,
  hold: false, held: [], writes: [], unexpected: [],
};

async function answerStatusWrite(route, request) {
  const body = JSON.parse(request.postData() ?? "{}");
  state.writes.push(body.status);
  if (state.hold) {
    const outcome = await new Promise((resolve) => state.held.push(resolve));
    if (outcome === "refuse") return route.fulfill({ status: 400, json: { error: REFUSED } });
  }
  const bead = state.beads.find((b) => b.id === "ab-1");
  bead.status = body.status;
  return route.fulfill({ json: structuredClone(bead) });
}

async function answer(route) {
  const request = route.request();
  const method = request.method();
  const path = new URL(request.url()).pathname;
  if (method === "POST" && path === STATUS_PATH) return answerStatusWrite(route, request);
  if (method !== "GET") {
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${path}` } });
  }
  if (path === "/api/viewer-mode") {
    state.viewerAnswers += 1;
    return route.fulfill({ json: { readOnly: false } });
  }
  if (path === "/api/projects") {
    return route.fulfill({ json: { projects: [{ id: alpha.id, name: alpha.name, path: null, hasBeads: true }] } });
  }
  if (path === "/api/p/alpha/beads") {
    const json = {
      beads: structuredClone(state.beads),
      meta: { kind: alpha.kind, humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 },
    };
    await route.fulfill({ json });
    state.listAnswered += 1;
    return undefined;
  }
  if (path === "/api/p/alpha/beads/stream") {
    // A finished response makes EventSource reconnect after `retry`; a change set by the test
    // rides on the next reconnect.
    let body = "retry: 200\n: connected\n\n";
    if (state.pendingChange) {
      state.pendingChange = false;
      body += "event: change\ndata: {}\n\n";
    }
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body });
  }
  if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
  if (path.endsWith("/activity")) return route.fulfill({ json: { items: [] } });
  return route.fulfill({ json: {} });
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
  assert.fail(`${label}${last ? ` (${last.message})` : ""}`);
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const statusSelect = () => page.locator("[data-bead-drawer] select").nth(0);
const columnOf = (id) => card(id).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
const bead = (id) => state.beads.find((b) => b.id === id);

function release(outcome) {
  const held = state.held.shift();
  assert.ok(held, `${step}: a status write is held`);
  held(outcome);
}

// What the tracker's first step does to the page: the stream announces a change and the list is
// read again. `title` is a change to the other bead, so the test can see that this read is on
// screen before it looks at the status.
async function readLands(title) {
  bead("ab-2").title = title;
  state.pendingChange = true;
  await card("ab-2").getByText(title, { exact: true }).waitFor();
}

async function shows(status, column, label) {
  assert.equal(await statusSelect().inputValue(), status, `${step}: ${label}, in the panel`);
  assert.equal(await columnOf("ab-1"), column, `${step}: ${label}, on the board`);
}

// Looked at for a while: a status that goes back and comes again has to be caught going back.
async function keepsShowing(status, column, label, forMs = 600) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await shows(status, column, label);
    await page.waitForTimeout(30);
  }
}

async function holdChange(to) {
  state.hold = true;
  const sent = state.writes.length;
  await statusSelect().selectOption(to);
  await eventually(() => state.writes.length === sent + 1 && state.held.length === 1, `${step}: the write was sent and is held`);
}

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/api/**", answer);
  await page.goto(`${base}/p/alpha?done=all`);

  step = "open the panel";
  await eventually(() => state.viewerAnswers > 0, "the viewer mode answered");
  await card("ab-1").click();
  await statusSelect().waitFor();
  await eventually(() => statusSelect().isEnabled(), "the panel can be edited");
  await shows("open", "Ready", "the bead starts open");

  step = "a read carrying the old status during a write";
  await holdChange("in_progress");
  await shows("in_progress", "In Progress", "the choice is shown before the tracker answers");
  let answered = state.listAnswered;
  await readLands("Alpha two, renamed");
  assert.ok(state.listAnswered > answered, `${step}: the list was read while the write was held`);
  assert.equal(bead("ab-1").status, "open", `${step}: that read carried the old status`);
  await keepsShowing("in_progress", "In Progress", "the read did not put the old status back");
  assert.equal(await columnOf("ab-2"), "Ready", `${step}: the bead with no write on its way is where the read says`);
  release("answer");
  await eventually(() => bead("ab-1").status === "in_progress", `${step}: the write was answered`);
  await keepsShowing("in_progress", "In Progress", "the answered status stays");

  step = "a later read rules once nothing is on its way";
  state.hold = false;
  bead("ab-1").status = "deferred";
  await readLands("Alpha two, renamed again");
  await eventually(async () => (await statusSelect().inputValue()) === "deferred", `${step}: the tracker's own status is shown`);
  await shows("deferred", "Backlog", "nothing of the finished write is kept on top of it");

  step = "a refused write";
  await holdChange("in_progress");
  answered = state.listAnswered;
  await readLands("Alpha two, renamed a third time");
  assert.ok(state.listAnswered > answered, `${step}: the list was read while the write was held`);
  await keepsShowing("in_progress", "In Progress", "the read did not put the old status back");
  release("refuse");
  await page.getByText(REFUSED).first().waitFor();
  await eventually(async () => (await statusSelect().inputValue()) === "deferred", `${step}: the panel is back on the tracker's status`);
  await keepsShowing("deferred", "Backlog", "the refused status does not come back");

  step = "requests";
  assert.deepEqual(state.writes, ["in_progress", "in_progress"], "one status write per change, nothing else");
  assert.deepEqual(state.unexpected, [], "no other write left the page");
  console.log("PASS project pending status: a read during a status write, a later read, a refused write");
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
