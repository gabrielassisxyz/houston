// The page of one sprint at /sprints/<id>: its beads, the backlog of every project, the capacity
// bar, the moves in and out, the size control and the link to the board. Every /api/ response
// comes from fixtures through page.route, so no tracker is read or written; the fixtures record
// each request and can hold the answer to a label write back, which is how the immediate move and
// the rollback are observed. Set PLANNING_SHOT to a file path to also save a screenshot.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const ID = "2026-11-23";
const LABEL = `sprint:${ID}`;
const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };

function sprint(start, state = "planned", capacity = 5) {
  return {
    id: start, name: `Sprint ${start}`, start, end: start.replace(/-\d\d$/, "-28"), capacity, state,
    createdAt: T, startedAt: null, closedAt: null, planned: null,
    unreadableAtStart: [], summary: null, pending: [],
  };
}

function bead(project, local, labels = [], o = {}) {
  return {
    id: `${project.id}:${local}`, local_id: local, project, title: o.title ?? `Title of ${local}`, description: "",
    status: o.status ?? "open", priority: o.priority ?? 2, issue_type: o.type ?? "task", labels, comments: [],
    dependencies: [], created_at: T, updated_at: o.updated ?? T,
  };
}

const browser = await chromium.launch();
let page;

async function openScenario({ url = `/sprints/${ID}`, sprints = [sprint(ID)], beads = [], failed = [], readOnly = false, beadsFail = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const state = { beads: [...beads], writes: [], nonGet: [], unrouted: [], gate: null, gates: {}, listGate: null, listFetches: 0, refuse: null };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== "GET") state.nonGet.push(`${method} ${path}`);
    if (path === "/api/all/beads/stream") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "retry: 600000\n: connected\n\n",
      });
    }
    if (path === "/api/viewer-mode") return route.fulfill({ json: { readOnly } });
    if (path === "/api/sprints") return route.fulfill({ json: { sprints } });
    if (path === "/api/all/beads") {
      state.listFetches += 1;
      if (state.listGate) await state.listGate;
      if (beadsFail) return route.fulfill({ status: 500, json: { error: "merged read broke" } });
      return route.fulfill({
        json: {
          beads: state.beads,
          meta: {
            kind: "all", readOnly: true, humanActor: "reviewer", humanAllowlist: [], pollIntervalMs: 300_000,
            projects: [{ ...alpha, kind: "br", count: 1 }, { ...beta, kind: "br", count: 1 }], failed,
          },
        },
      });
    }
    const labels = path.match(/^\/api\/p\/([^/]+)\/beads\/([^/]+)\/labels$/);
    if (labels && method === "POST") {
      const [, projectId, own] = labels;
      const body = JSON.parse(request.postData());
      state.writes.push({ path, body });
      if (state.gate) await state.gate.promise;
      if (state.gates[own]) await state.gates[own];
      if (state.refuse) return route.fulfill({ status: state.refuse.status, json: state.refuse.body });
      // A successful write changes the tracker, so the refetch that follows agrees with the move.
      const target = state.beads.find((b) => b.project.id === projectId && b.local_id === decodeURIComponent(own));
      target.labels = [...target.labels.filter((l) => !body.remove.includes(l)), ...body.add];
      return route.fulfill({ json: target });
    }
    state.unrouted.push(`${method} ${path}`);
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}${url}`);
  return { context, state };
}

function hold(state) {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  state.gate = { promise };
  return release;
}

const row = (id) => page.locator(`[data-bead-id="${id}"]`);
const members = () => page.getByTestId("members");
const backlog = () => page.getByTestId("backlog");
const idsIn = (section) => section.locator("[data-testid=sprint-bead]").evaluateAll((els) => els.map((el) => el.getAttribute("data-bead-id")));
const bar = () => page.getByTestId("capacity-bar");
const loaded = () => members().waitFor();

try {
  let s;

  // Members are the labelled beads, open before closed; the backlog is open, non-epic, non-archived
  // work in no sprint at all.
  s = await openScenario({
    beads: [
      bead(alpha, "a-done", [LABEL, "size:S"], { status: "closed" }),
      bead(alpha, "a-open", [LABEL, "size:M"]),
      bead(beta, "b-other", ["sprint:2026-11-30"]),
      bead(alpha, "a-free", []),
      bead(alpha, "a-closed", [], { status: "closed" }),
      bead(alpha, "a-epic", [], { type: "epic" }),
      bead(alpha, "a-arch", ["archived"]),
    ],
  });
  await loaded();
  await backlog().waitFor();
  assert.deepEqual(await idsIn(members()), ["alpha:a-open", "alpha:a-done"], "members: open before closed, nothing else");
  assert.deepEqual(await idsIn(backlog()), ["alpha:a-free"], "backlog: only open, non-epic, non-archived work in no sprint");
  assert.match(await row("alpha:a-open").innerText(), /Alpha App/, "a row names its project");
  assert.match(await row("alpha:a-open").innerText(), /a-open/, "a row shows the bead's own id");
  if (process.env.PLANNING_SHOT) await page.screenshot({ path: process.env.PLANNING_SHOT });
  await s.context.close();

  // Two moves in flight: the first one to settle must not refetch a list that lacks the second,
  // or the second row would jump back to the backlog until its own answer arrived.
  s = await openScenario({ beads: [bead(alpha, "a-1", ["size:S"]), bead(alpha, "a-2", ["size:S"])] });
  await loaded();
  await backlog().waitFor();
  {
    let releaseFirst, releaseSecond;
    s.state.gates = {
      "a-1": new Promise((resolve) => (releaseFirst = resolve)),
      "a-2": new Promise((resolve) => (releaseSecond = resolve)),
    };
    await row("alpha:a-1").getByRole("button", { name: "Move in a-1" }).click();
    await row("alpha:a-2").getByRole("button", { name: "Move in a-2" }).click();
    await members().locator('[data-bead-id="alpha:a-2"]').waitFor();
    const fetched = s.state.listFetches;
    releaseFirst();
    await page.waitForTimeout(400);
    assert.equal(s.state.listFetches, fetched, "no refetch while another move is still in flight");
    assert.deepEqual((await idsIn(members())).sort(), ["alpha:a-1", "alpha:a-2"], "both rows stay in the sprint");
    releaseSecond();
    for (let i = 0; i < 50 && s.state.listFetches === fetched; i++) await page.waitForTimeout(100);
    assert.equal(s.state.listFetches, fetched + 1, "the last move to settle refetches once");
  }
  await s.context.close();

  // Two projects hold a bead called ab-1: the write goes to beta, to the bead's own id.
  s = await openScenario({ beads: [bead(alpha, "ab-1"), bead(beta, "ab-1")] });
  await backlog().waitFor();
  await row("beta:ab-1").getByRole("button", { name: "Move in ab-1" }).click();
  await members().locator('[data-bead-id="beta:ab-1"]').waitFor();
  assert.deepEqual(s.state.writes, [{ path: "/api/p/beta/beads/ab-1/labels", body: { add: [LABEL], remove: [] } }]);
  assert.deepEqual(await idsIn(backlog()), ["alpha:ab-1"], "alpha's bead stays in the backlog");
  await s.context.close();

  // The row moves before the server answers, and comes back with the server's words on a refusal.
  s = await openScenario({
    beads: [bead(alpha, "a-m", [LABEL, "size:M"]), bead(beta, "b-1", ["size:L"])],
  });
  await backlog().waitFor();
  const before = await bar().innerText();
  assert.match(before, /2 \/ 5 points/);
  const release = hold(s.state);
  await row("beta:b-1").getByRole("button", { name: "Move in b-1" }).click();
  await members().locator('[data-bead-id="beta:b-1"]').waitFor();
  assert.deepEqual(await idsIn(backlog()), [], "the row left the backlog with the answer still held");
  assert.match(await bar().innerText(), /5 \/ 5 points/, "the bar already counts its points");
  assert.equal(await members().locator('[data-bead-id="beta:b-1"]').getByRole("button", { name: "Move out b-1" }).isDisabled(), true, "controls are disabled while the request is in flight");
  s.state.refuse = { status: 400, body: { error: "Project beta is tracked with bd", code: "unsupported" } };
  // The refetch after the refusal is held too, so only the rollback itself can put the row back.
  let releaseList;
  s.state.listGate = new Promise((resolve) => (releaseList = resolve));
  release();
  await backlog().locator('[data-bead-id="beta:b-1"]').waitFor();
  // Still before the refetch: the rollback has to restore the bead's own labels, size included,
  // not merely take the sprint label away.
  assert.match(await backlog().locator('[data-bead-id="beta:b-1"]').innerText(), /3 pts/, "the rollback keeps the bead's size");
  releaseList();
  assert.deepEqual(await idsIn(members()), ["alpha:a-m"], "after a refusal the row is back in the backlog");
  assert.equal(await bar().innerText(), before, "the bar is back to its previous text");
  await page.getByText("Project beta is tracked with bd").waitFor();
  await s.context.close();

  // Moving out removes the label from the bead's own project.
  s = await openScenario({ beads: [bead(alpha, "ab-1", [LABEL]), bead(beta, "ab-1", [LABEL])] });
  await members().waitFor();
  await row("beta:ab-1").getByRole("button", { name: "Move out ab-1" }).click();
  await backlog().locator('[data-bead-id="beta:ab-1"]').waitFor();
  assert.deepEqual(s.state.writes, [{ path: "/api/p/beta/beads/ab-1/labels", body: { add: [], remove: [LABEL] } }]);
  await s.context.close();

  // Sizes: add on a bead with none, swap on a sized one, nothing for the size it already has.
  s = await openScenario({ beads: [bead(alpha, "a-none"), bead(alpha, "a-s", ["size:S"])] });
  await backlog().waitFor();
  await row("alpha:a-none").getByRole("button", { name: "Size M for a-none" }).click();
  await row("alpha:a-none").getByText("2 pts").waitFor();
  await row("alpha:a-s").getByRole("button", { name: "Size L for a-s" }).click();
  await row("alpha:a-s").getByText("3 pts").waitFor();
  assert.deepEqual(s.state.writes, [
    { path: "/api/p/alpha/beads/a-none/labels", body: { add: ["size:M"], remove: [] } },
    { path: "/api/p/alpha/beads/a-s/labels", body: { add: ["size:L"], remove: ["size:S"] } },
  ]);
  await row("alpha:a-none").getByRole("button", { name: "Size M for a-none" }).click();
  await page.waitForTimeout(300);
  assert.equal(s.state.writes.length, 2, "choosing the size a bead already has sends nothing");
  await s.context.close();

  // The bar: 5 / 5 with one unsized member, then over capacity once an S bead comes in.
  s = await openScenario({
    beads: [
      bead(alpha, "a-l", [LABEL, "size:L"]), bead(alpha, "a-m", [LABEL, "size:M"]), bead(alpha, "a-u", [LABEL]),
      bead(beta, "b-s", ["size:S"]),
    ],
  });
  await backlog().waitFor();
  assert.match(await bar().innerText(), /5 \/ 5 points/);
  assert.match(await bar().innerText(), /1 unsized/);
  assert.ok(!(await bar().innerText()).includes("over capacity"), "not over at exactly the capacity");
  assert.ok(!(await bar().innerText()).includes("done"), "a planned sprint has no done figure");
  await row("beta:b-s").getByRole("button", { name: "Move in b-s" }).click();
  await members().locator('[data-bead-id="beta:b-s"]').waitFor();
  assert.match(await bar().innerText(), /6 \/ 5 points/);
  assert.match(await bar().innerText(), /1 over capacity/);
  assert.match(await bar().innerText(), /1 unsized/);
  await s.context.close();

  // A running sprint counts its closed members, and says how many points are done.
  s = await openScenario({
    sprints: [sprint(ID, "active", 10)],
    beads: [
      bead(alpha, "a-d", [LABEL, "size:L"], { status: "closed" }), bead(alpha, "a-o", [LABEL, "size:M"]),
      bead(alpha, "a-cu", [LABEL], { status: "closed" }),
    ],
  });
  await members().waitFor();
  assert.match(await bar().innerText(), /5 \/ 10 points/, "closed members count as committed");
  assert.match(await bar().innerText(), /3 done/);
  assert.match(await bar().innerText(), /1 unsized/, "a closed member without a size is unsized too");
  await backlog().waitFor();
  await s.context.close();

  // The backlog narrows by project and by text.
  s = await openScenario({
    beads: [bead(alpha, "a-1", [], { title: "Fix login" }), bead(alpha, "a-2", [], { title: "Paint it" }), bead(beta, "b-1", [], { title: "Fix billing" })],
  });
  await backlog().waitFor();
  assert.equal((await idsIn(backlog())).length, 3);
  await page.getByRole("button", { name: "Alpha App", exact: true }).click();
  assert.deepEqual((await idsIn(backlog())).sort(), ["alpha:a-1", "alpha:a-2"], "the project filter narrows the backlog");
  await page.getByRole("searchbox", { name: "Search the backlog" }).fill("login");
  assert.deepEqual(await idsIn(backlog()), ["alpha:a-1"], "the search narrows it further");
  await page.getByRole("button", { name: "Alpha App", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search the backlog" }).fill("fix");
  assert.deepEqual((await idsIn(backlog())).sort(), ["alpha:a-1", "beta:b-1"], "with no project chosen the search covers every project");
  await s.context.close();

  // A closed sprint, and read-only mode, show beads with no control and no backlog.
  const controlled = [bead(alpha, "a-m", [LABEL, "size:M"]), bead(alpha, "a-free")];
  s = await openScenario({ sprints: [sprint(ID, "closed")], beads: controlled });
  await members().waitFor();
  await page.waitForTimeout(200);
  assert.deepEqual(await idsIn(members()), ["alpha:a-m"]);
  assert.equal(await page.getByRole("button", { name: /^(Move|Size)/ }).count(), 0, "closed sprint: no move or size control");
  assert.equal(await backlog().count(), 0, "closed sprint: no backlog");
  await s.context.close();
  // A sprint whose close has not finished is no more editable than a closed one.
  s = await openScenario({ sprints: [sprint(ID, "closing")], beads: controlled });
  await loaded();
  await page.waitForTimeout(200); // the viewer mode has to have arrived, or the page is read-only anyway
  assert.equal(await page.getByRole("button", { name: /^(Move|Size)/ }).count(), 0, "closing sprint: no move or size control");
  assert.equal(await backlog().count(), 0, "closing sprint: no backlog");
  await s.context.close();
  s = await openScenario({ readOnly: true, beads: controlled });
  await members().waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await idsIn(members()), ["alpha:a-m"]);
  assert.equal(await page.getByRole("button", { name: /^(Move|Size)/ }).count(), 0, "read-only: no move or size control");
  assert.equal(await backlog().count(), 0, "read-only: no backlog");
  assert.deepEqual(s.state.nonGet, [], "read-only: nothing but GET leaves the page");
  await s.context.close();

  // An id that matches no sprint says so and links back.
  s = await openScenario({ url: "/sprints/2031-01-01", beads: controlled });
  await page.getByText("No sprint starts on 2031-01-01.").waitFor();
  assert.equal(await page.getByRole("main").getByRole("link", { name: "Back to sprints" }).getAttribute("href"), "/sprints");
  assert.equal(await members().count(), 0, "an unknown sprint is not shown as an empty one");
  await s.context.close();

  // The board link keeps both parameters, the label encoded.
  s = await openScenario({ beads: controlled });
  await members().waitFor();
  const href = await page.getByRole("link", { name: "Open on the board" }).getAttribute("href");
  assert.ok(href.startsWith("/all?"), "the link leads to the all-projects page");
  assert.ok(href.includes("label=sprint%3A2026-11-23"), `label encoded in ${href}`);
  const query = new URL(href, base).searchParams;
  assert.equal(query.get("label"), LABEL);
  assert.equal(query.get("done"), "all");
  await s.context.close();

  // A project that could not be read is named; a bead list that could not be read is not shown empty.
  s = await openScenario({ beads: controlled, failed: [{ ...beta, error: "tracker unreadable" }] });
  const notice = page.getByRole("alert").filter({ hasText: "Beta Tools" });
  await notice.waitFor();
  assert.match(await notice.innerText(), /tracker unreadable/);
  await s.context.close();
  s = await openScenario({ beadsFail: true });
  await page.getByRole("main").getByRole("alert").filter({ hasText: "Couldn’t read the beads" }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await members().count(), 0, "no members list when the beads could not be read");
  assert.equal(await backlog().count(), 0, "no backlog when the beads could not be read");
  assert.equal(await page.getByText(/points/).count(), 0, "no count when the beads could not be read");
  await s.context.close();

  console.log("PASS: /sprints/<id> fills a sprint from the backlog of every project, moves rows at once and rolls back on refusal");
} catch (error) {
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
