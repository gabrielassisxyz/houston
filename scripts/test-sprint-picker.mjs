// The sprints listing at /sprints lets several beads be added to one sprint at once: an "Add
// beads" button per sprint that can still be planned, a list of the open work of every project
// with a box to tick on each row, an epic that ticks every bead under it, and one confirmation
// that writes the sprint's label to each chosen bead in its own project.
//
// Two halves. The first answers every /api/ request from fixtures through page.route, can hold or
// refuse a label write, and applies a write to the fixture only when it is answered. The second
// uses the real server, one throwaway br tracker and a real sprint, and reads the labels back
// with br; it writes through the API, so it needs a launch that can edit.
//   SPRINT_PICKER_HALF=fixtures|server runs one half alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");
const half = process.env.SPRINT_PICKER_HALF ?? "both";
const BR = process.env.BR_BIN || "br";

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const beta = { id: "beta", name: "Beta Tools", kind: "br" };
const gamma = { id: "gamma", name: "Gamma Old", kind: "bd" };
const PROJECTS = [alpha, beta, gamma];
const PLAN = "2026-11-23";
const LABEL = `sprint:${PLAN}`;
const REFUSED = "Refused by the fixture";
const BD_NOTE = "labels cannot be edited on a bd project";

function sprint(start, name, state, capacity = 20) {
  return {
    id: start, name, start, end: start.replace(/-\d\d$/, "-28"), capacity, state,
    createdAt: T, startedAt: null, closedAt: null, planned: null,
    unreadableAtStart: [], summary: null, pending: [],
  };
}
const SPRINTS = () => [
  sprint(PLAN, "Plan A", "planned"),
  sprint("2026-11-16", "Running", "active"),
  sprint("2026-11-09", "Wrapping", "closing"),
  sprint("2026-10-05", "Old one", "closed"),
];

function bead(project, local, extra = {}) {
  const { parent, ...rest } = extra;
  const id = `${project.id}:${local}`;
  return {
    id, local_id: local, project: { id: project.id, name: project.name }, title: `${project.name.split(" ")[0]} ${local}`,
    description: "", status: "open", priority: 2, issue_type: "task", labels: [], comments: [], created_at: T, updated_at: T,
    dependencies: parent ? [{ issue_id: id, depends_on_id: `${project.id}:${parent}`, type: "parent-child" }] : [],
    ...rest,
  };
}

// Alpha's epic e-1 holds a-6 and s-1, s-1 holds a-7, and a-8 under it is closed: three beads can
// go in. Its epic e-2 holds only a bead that is already in a sprint. Both projects have an a-1.
const seedBeads = () => [
  bead(alpha, "a-1", { priority: 1 }),
  bead(alpha, "a-2", { labels: ["size:M"], updated_at: "2026-09-05T00:00:00Z" }),
  bead(alpha, "a-3", { status: "closed" }),
  bead(alpha, "a-4", { labels: ["archived"] }),
  bead(alpha, "a-5", { labels: ["sprint:2026-11-16"], parent: "e-2" }),
  bead(alpha, "e-1", { issue_type: "epic", priority: 1, updated_at: "2026-09-09T00:00:00Z" }),
  bead(alpha, "a-6", { parent: "e-1", priority: 3 }),
  bead(alpha, "s-1", { parent: "e-1", priority: 3, updated_at: "2026-09-02T00:00:00Z" }),
  bead(alpha, "a-7", { parent: "s-1", priority: 4 }),
  bead(alpha, "a-8", { parent: "e-1", status: "closed" }),
  bead(alpha, "e-2", { issue_type: "epic" }),
  bead(beta, "a-1", { updated_at: "2026-09-04T00:00:00Z" }),
  bead(beta, "b-2", { updated_at: "2026-09-03T00:00:00Z" }),
  bead(gamma, "g-1", { priority: 0 }),
];

const browser = await chromium.launch();
let page;
let state;
// Named in the failure report: a wait that times out says only TimeoutError.
let step = "start";

async function openScenario({ readOnly = false, holdMode = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  state = {
    beads: seedBeads(), listReads: 0, writes: [], inFlight: new Map(), sideBySide: false, tooMany: [],
    hold: false, held: [], refuse: () => false, unexpected: [],
  };
  if (holdMode) state.modeGate = new Promise((resolve) => (state.releaseMode = resolve));
  const s = state;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/all/beads/stream") {
      return route.fulfill({
        status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "retry: 600000\n: connected\n\n",
      });
    }
    const labels = pathname.match(/^\/api\/p\/([^/]+)\/beads\/([^/]+)\/labels$/);
    if (method === "POST" && labels) {
      const write = { projectId: labels[1], own: labels[2], body: JSON.parse(request.postData() ?? "{}") };
      s.writes.push(write);
      const open = (s.inFlight.get(write.projectId) ?? 0) + 1;
      s.inFlight.set(write.projectId, open);
      if (open > 1) s.tooMany.push(`${write.projectId}/${write.own}`);
      if ([...s.inFlight.values()].filter((n) => n > 0).length > 1) s.sideBySide = true;
      if (s.hold) await new Promise((resolve) => s.held.push({ write, resolve }));
      s.inFlight.set(write.projectId, s.inFlight.get(write.projectId) - 1);
      if (s.refuse(write)) return route.fulfill({ status: 400, json: { error: REFUSED } });
      const target = s.beads.find((b) => b.id === `${write.projectId}:${write.own}`);
      target.labels = [...target.labels.filter((l) => !write.body.remove.includes(l)), ...write.body.add];
      return route.fulfill({ json: structuredClone(target) });
    }
    if (method !== "GET") {
      s.unexpected.push(`${method} ${pathname}`);
      return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${pathname}` } });
    }
    if (pathname === "/api/viewer-mode") {
      if (s.modeGate) await s.modeGate;
      return route.fulfill({ json: { readOnly } });
    }
    if (pathname === "/api/sprints") return route.fulfill({ json: { sprints: SPRINTS() } });
    if (pathname === "/api/all/beads") {
      s.listReads += 1;
      return route.fulfill({
        json: {
          beads: structuredClone(s.beads),
          meta: {
            kind: "all", readOnly, humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000,
            projects: PROJECTS.map((p) => ({ ...p, count: s.beads.filter((b) => b.project.id === p.id).length })), failed: [],
          },
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/sprints`);
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

const sprintRow = (name) => page.getByTestId("sprint-row").filter({ hasText: name });
const addButton = (name) => page.getByRole("button", { name: `Add beads to ${name}`, exact: true });
const dialog = () => page.getByRole("dialog");
const rows = () => dialog().getByTestId("sprint-bead");
const rowOf = (id) => dialog().locator(`[data-bead-id="${id}"]`);
const boxOf = (id) => rowOf(id).getByRole("checkbox");
const rowIds = () => rows().evaluateAll((els) => els.map((el) => el.getAttribute("data-bead-id")));
const confirmButton = () => dialog().getByRole("button", { name: /^Add \d+$|^Adding/ });
const checked = (id) => boxOf(id).getAttribute("aria-checked");

async function openPicker(name) {
  await addButton(name).click();
  await dialog().getByRole("heading", { name: `Add beads to ${name}`, exact: true }).waitFor();
}

function release() {
  const next = state.held.shift();
  assert.ok(next, `${step}: a write is held`);
  next.resolve();
  return next.write;
}

async function fixtureHalf() {
  step = "button before the viewer mode answers";
  let context = await openScenario({ holdMode: true });
  await sprintRow("Plan A").getByText("0 beads").waitFor();
  assert.equal(await addButton("Plan A").isDisabled(), true, "disabled until the viewer mode has answered");
  state.releaseMode();
  await eventually(() => addButton("Plan A").isEnabled(), "enabled once the page can be edited");

  step = "button per sprint state";
  assert.equal(await addButton("Plan A").innerText(), "Add beads");
  assert.equal(await addButton("Running").count(), 1, "an active sprint has the button");
  assert.equal(await addButton("Wrapping").count(), 0, "a closing sprint has none");
  assert.equal(await addButton("Old one").count(), 0, "a closed sprint has none");

  step = "rows offered";
  await openPicker("Plan A");
  // Priority first, then the most recently updated: gamma's P0, alpha's P1 epic and bead, the P2s.
  assert.deepEqual(
    await rowIds(),
    ["gamma:g-1", "alpha:e-1", "alpha:a-1", "alpha:a-2", "beta:a-1", "beta:b-2", "alpha:s-1", "alpha:a-6", "alpha:a-7"],
    "open work of every project in the backlog's order; nothing closed, archived or already in a sprint; no epic with nothing to offer",
  );
  const first = (await rowOf("alpha:a-2").innerText()).replace(/\s+/g, " ");
  assert.match(first, /Alpha App/, "project chip");
  assert.match(first, /a-2 Alpha a-2 task · P2 2 pts/, "own id, title, type and priority, points");
  assert.match((await rowOf("alpha:e-1").innerText()).replace(/\s+/g, " "), /epic · P1 3 beads$/, "an epic says how many beads it stands for");
  assert.equal(await confirmButton().innerText(), "Add 0");
  assert.equal(await confirmButton().isDisabled(), true, "nothing ticked, nothing to add");

  step = "an epic ticks the beads under it";
  await boxOf("alpha:e-1").click();
  for (const id of ["alpha:a-6", "alpha:s-1", "alpha:a-7"]) assert.equal(await checked(id), "true", `${id} under the epic is ticked`);
  assert.equal(await checked("alpha:a-1"), "false", "a bead outside the epic is not");
  assert.equal(await checked("alpha:e-1"), "true");
  assert.equal(await confirmButton().innerText(), "Add 3", "the epic itself is not counted");
  await boxOf("alpha:a-7").click();
  assert.equal(await checked("alpha:e-1"), "mixed", "partly ticked");
  assert.equal(await confirmButton().innerText(), "Add 2");
  await boxOf("alpha:e-1").click();
  assert.equal(await checked("alpha:a-7"), "true", "ticking a partly ticked epic ticks the rest");
  await boxOf("alpha:e-1").click();
  for (const id of ["alpha:a-6", "alpha:s-1", "alpha:a-7"]) assert.equal(await checked(id), "false", `${id} is unticked with the epic`);
  assert.equal(await confirmButton().innerText(), "Add 0");

  step = "bd rows";
  assert.equal(await boxOf("gamma:g-1").isDisabled(), true, "a bead of a bd project cannot be ticked");
  assert.match(await rowOf("gamma:g-1").innerText(), new RegExp(BD_NOTE), "and says why");

  step = "filters";
  await boxOf("alpha:a-1").click();
  await dialog().getByRole("searchbox", { name: "Search the backlog" }).fill("a-1");
  assert.deepEqual(await rowIds(), ["alpha:a-1", "beta:a-1"], "search by own id");
  await dialog().getByRole("button", { name: "Beta Tools", exact: true }).click();
  assert.deepEqual(await rowIds(), ["beta:a-1"], "and by project");
  assert.equal(await confirmButton().innerText(), "Add 1", "a ticked bead filtered out of sight stays ticked");
  await dialog().getByRole("searchbox", { name: "Search the backlog" }).fill("");
  assert.deepEqual(await rowIds(), ["beta:a-1", "beta:b-2"], "the project filter alone");
  await dialog().getByRole("button", { name: "Beta Tools", exact: true }).click();
  assert.equal(await checked("alpha:a-1"), "true");

  step = "writes";
  await boxOf("alpha:a-2").click();
  await boxOf("alpha:e-1").click();
  await boxOf("beta:a-1").click();
  await boxOf("beta:b-2").click();
  assert.equal(await confirmButton().innerText(), "Add 7");
  const readsBefore = state.listReads;
  state.hold = true;
  await confirmButton().click();
  await eventually(() => state.held.length === 2, "one write per project goes out first");
  assert.deepEqual(state.held.map((h) => `${h.write.projectId}/${h.write.own}`).sort(), ["alpha/a-1", "beta/a-1"]);
  await page.waitForTimeout(300);
  assert.equal(state.writes.length, 2, "the second bead of a project waits for the first to be answered");
  assert.equal(await confirmButton().isDisabled(), true, "no second confirmation while adding");
  // Answered one at a time. A write held while another of its project is still out is counted
  // in tooMany by the fixture, so the order below needs no timing to be checked.
  for (let answered = 0; answered < 7; answered += 1) {
    await eventually(() => state.held.length > 0, `write ${answered + 1} of 7 is waiting to be answered`);
    const done = release();
    if (answered > 0) continue;
    // Shown as each write is answered, not when the list is read again at the end.
    await eventually(async () => !(await rowIds()).includes(`${done.projectId}:${done.own}`), "a bead that was written leaves the list while others are still on their way");
    assert.equal(state.listReads, readsBefore, "and the merged list has not been read again yet");
  }
  await dialog().waitFor({ state: "hidden" });
  assert.deepEqual(
    state.writes.filter((w) => w.projectId === "alpha").map((w) => w.own),
    ["a-1", "a-2", "s-1", "a-6", "a-7"],
    "alpha's beads in the order of the list, the epic never",
  );
  assert.deepEqual(state.writes.filter((w) => w.projectId === "beta").map((w) => w.own), ["a-1", "b-2"], "each under its own id in its own project");
  for (const w of state.writes) assert.deepEqual(w.body, { add: [LABEL], remove: [] }, `${w.projectId}/${w.own}: the sprint's label`);
  assert.deepEqual(state.tooMany, [], "never two writes to one project at once");
  assert.equal(state.sideBySide, true, "two projects were written side by side");
  assert.deepEqual(state.unexpected, [], "no other write");

  step = "the listing afterwards";
  await sprintRow("Plan A").getByText("7 beads").waitFor();
  await sprintRow("Plan A").getByText("2 / 20 points").waitFor();
  await page.waitForTimeout(400);
  assert.equal(state.listReads, readsBefore + 1, "the merged list was read again exactly once");
  await context.close();

  step = "refused writes";
  context = await openScenario();
  await eventually(() => addButton("Running").isEnabled(), "the page can be edited");
  await openPicker("Running");
  for (const id of ["alpha:a-1", "alpha:a-2", "beta:b-2"]) await boxOf(id).click();
  state.refuse = (w) => w.own === "a-2";
  await confirmButton().click();
  await dialog().getByRole("alert").waitFor();
  assert.equal(await dialog().getByRole("alert").count(), 1, "exactly one message");
  assert.equal(await dialog().getByRole("alert").innerText(), `1 of 3 beads could not be added: ${REFUSED}`);
  await eventually(async () => !(await rowIds()).includes("alpha:a-1"), "the beads that were written left the list");
  assert.equal((await rowIds()).includes("beta:b-2"), false);
  assert.equal(await checked("alpha:a-2"), "true", "the refused bead is still ticked");
  assert.equal(await confirmButton().innerText(), "Add 1", "and it is the only one");
  await sprintRow("Running").getByText("3 beads").waitFor({ state: "attached" });
  assert.equal(state.writes.length, 3, "one attempt per bead");
  state.refuse = () => false;
  await confirmButton().click();
  await dialog().waitFor({ state: "hidden" });
  await sprintRow("Running").getByText("4 beads").waitFor();
  await context.close();

  step = "read-only viewer mode";
  context = await openScenario({ readOnly: true });
  await sprintRow("Plan A").getByText("0 beads").waitFor();
  await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();
  assert.equal(await addButton("Plan A").isDisabled(), true, "disabled in read-only mode");
  assert.equal(await addButton("Running").isDisabled(), true);
  assert.deepEqual(state.writes, [], "and nothing was written");
  await context.close();
}

async function serverHalf() {
  try {
    execFileSync(BR, ["--version"], { stdio: "ignore" });
  } catch {
    assert.fail("the real-server half needs br on PATH (or BR_BIN)");
  }
  step = "real server";
  // cwd is always the throwaway folder: br resolves its tracker from there.
  const br = (dir, args) => execFileSync(BR, args, { cwd: dir, encoding: "utf8" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-picker-"));
  const start = "2031-03-03";
  let projectId;
  let sprintMade = false;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    br(dir, ["init", "--prefix", "pk"]);
    const epic = JSON.parse(br(dir, ["create", "Picker epic", "-t", "epic", "--json"])).id;
    const children = [];
    for (let n = 1; n <= 12; n += 1) {
      const id = JSON.parse(br(dir, ["create", `Picker bead ${n}`, "--json"])).id;
      br(dir, ["dep", "add", id, epic, "--type", "parent-child"]);
      children.push(id);
    }
    const added = await fetch(`${base}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }),
    });
    assert.equal(added.status, 201, `register ${dir}: ${await added.clone().text()}`);
    projectId = (await added.json()).id;
    const made = await fetch(`${base}/api/sprints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Picker sprint", start, end: "2031-03-14", capacity: 20 }),
    });
    assert.equal(made.status, 201, `create the sprint: ${await made.clone().text()}`);
    sprintMade = true;

    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const labelPath = new RegExp(`^/api/p/${projectId}/beads/([^/]+)/labels$`);
    const sent = [];
    const answered = [];
    let open = 0;
    let overlap = false;
    page.on("request", (r) => {
      const own = new URL(r.url()).pathname.match(labelPath)?.[1];
      if (r.method() !== "POST" || !own) return;
      sent.push(own);
      open += 1;
      if (open > 1) overlap = true;
    });
    page.on("response", (r) => {
      if (r.request().method() !== "POST" || !labelPath.test(new URL(r.url()).pathname)) return;
      open -= 1;
      answered.push(r.status());
    });
    const mode = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/viewer-mode");
    await page.goto(`${base}/sprints`);
    assert.equal((await (await mode).json()).readOnly, false, "this half writes through the API and needs an editing launch");
    await eventually(() => addButton("Picker sprint").isEnabled(), "the sprint's button can be pressed");
    await openPicker("Picker sprint");
    await boxOf(`${projectId}:${epic}`).click();
    assert.equal(await confirmButton().innerText(), "Add 12", "the epic chose its twelve beads");
    await confirmButton().click();
    await dialog().waitFor({ state: "hidden", timeout: 60_000 });

    assert.deepEqual(answered, Array(12).fill(200), "twelve writes, all accepted");
    assert.deepEqual([...sent].sort(), [...children].sort(), "one write per bead under the epic, none for the epic");
    assert.equal(overlap, false, "the writes to the one tracker went out one at a time");
    for (const id of children) {
      const labels = JSON.parse(br(dir, ["show", id, "--json"]))[0].labels ?? [];
      assert.ok(labels.includes(`sprint:${start}`), `br show ${id}: carries the sprint's label, has ${JSON.stringify(labels)}`);
    }
    assert.ok(!(JSON.parse(br(dir, ["show", epic, "--json"]))[0].labels ?? []).includes(`sprint:${start}`), "br show: the epic has no sprint label");
    await sprintRow("Picker sprint").getByText("12 beads").waitFor();
    return true;
  } finally {
    await context.close();
    if (sprintMade) await fetch(`${base}/api/sprints/${start}`, { method: "DELETE" }).catch(() => {});
    if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const ran = [];
  if (half !== "server") {
    await fixtureHalf();
    ran.push("button per state, rows offered, an epic and the beads under it, filters, bd rows, one write at a time per project, refused writes, read-only");
  }
  if (half !== "fixtures" && (await serverHalf())) ran.push("real server: twelve beads under an epic labelled in one tracker");
  console.log(`PASS sprint picker: ${ran.join("; ")}`);
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
