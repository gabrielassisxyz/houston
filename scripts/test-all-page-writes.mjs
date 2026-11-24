// The all-projects page at /all acts on beads. A drag between columns of the board, or between
// groups of the list, writes the bead's status to its own project under its own id, and the New
// buttons ask which project a bead is for before the form exists.
//
// The first half answers every /api/ request from fixtures through page.route. They record each
// request, hold every later read of the list (so only an answer put into the cache can change the
// screen), can hold or refuse a chosen write, and fail on any non-GET they do not know. The second
// half drives the server itself, with no interception, against two throwaway br trackers. It
// writes through the API, so it fails under a read-only launch. PAGE_WRITES_HALF=fixtures or
// =server runs one half alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");
const half = process.env.PAGE_WRITES_HALF ?? "both";

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const beta = { id: "beta", name: "Beta Tools", kind: "bd" };
const delta = { id: "delta", name: "Delta Empty", kind: "br" };
// Named like beta, so only the id tells the two apart.
const gamma = { id: "gamma", name: "Beta Tools", kind: "br" };
const omega = { id: "omega", name: "Omega Down", error: "tracker unreadable" };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const BLOCKED = "Cannot start ab-2: it is blocked by ab-9, which is still open";

// Nothing that leaves the page may name the pseudo project or a namespaced id.
const FORBIDDEN = /(@|%40)all|(alpha|beta|gamma|delta)(:|%3a)/i;
function namesForbidden({ path: requestPath, body }) {
  let decoded = requestPath;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // Malformed percent-encoding is still checked as it is.
  }
  return FORBIDDEN.test(requestPath) || FORBIDDEN.test(decoded) || FORBIDDEN.test(body);
}
// The scan at the end passes on an empty match, so it is shown to match what it is for.
for (const sample of [
  { path: "/api/p/%40all/order", body: "" },
  { path: "/api/p/beta/beads/beta%3Aab-1/status", body: "" },
  { path: "/api/p/beta/beads", body: '{"title":"x","parent":"beta:e-1"}' },
]) {
  assert.ok(namesForbidden(sample), `the scan flags ${sample.path} ${sample.body}`);
}
assert.ok(!namesForbidden({ path: "/api/p/beta/beads/ab-1/status", body: '{"status":"open"}' }), "the scan passes a plain id");

const dep = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

// Alpha and beta hold the same own ids, so a write that loses its project lands on the twin.
function seedBeads(project) {
  const word = project.name.split(" ")[0];
  const own = (id, title, extra = {}) => ({
    id, title, description: "", status: "open", priority: 2, issue_type: "task", assignee: "",
    labels: [], comments: [], dependencies: [], created_by: "reviewer", created_at: T, updated_at: T,
    ...extra,
  });
  return [
    own("ab-1", `${word} one`),
    own("ab-2", `${word} two`),
    own("ab-3", `${word} three`, { status: "in_progress" }),
    own("e-1", `${word} epic`, { issue_type: "epic" }),
  ];
}

// The merged form, the way lib/aggregate.ts namespaces a bead.
function mergedOf(project, bead) {
  const ns = (id) => `${project.id}:${id}`;
  const copy = structuredClone(bead);
  const merged = {
    ...copy,
    id: ns(bead.id),
    local_id: bead.id,
    project: { id: project.id, name: project.name },
    dependencies: copy.dependencies.map((d) => ({ ...d, issue_id: ns(d.issue_id), depends_on_id: ns(d.depends_on_id) })),
  };
  if (bead.parent) merged.parent = ns(bead.parent);
  return merged;
}

const allRequests = [];
const browser = await chromium.launch();
let page;
let state;
// Named in the failure report: a wait that times out says only TimeoutError.
let step = "start";

function mergedResponse(s) {
  return {
    beads: s.projects.flatMap((p) => (s.beads[p.id] ?? []).map((b) => mergedOf(p, b))),
    meta: {
      kind: "all", readOnly: s.readOnly, humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000,
      projects: s.projects.map((p) => ({ ...p, count: (s.beads[p.id] ?? []).length })),
      failed: s.failed,
    },
  };
}

// The first read of a page is answered; every later one waits until the test lets it go.
async function answerList(route, s, json) {
  s.listFetches += 1;
  if (s.listFetches > 1) await new Promise((resolve) => s.heldLists.push(resolve));
  s.listAnswered += 1;
  return route.fulfill({ json }).catch(() => {});
}

async function answerRead(route, s, requestPath) {
  if (requestPath === "/api/viewer-mode") {
    if (s.modeGate) await s.modeGate;
    s.viewerAnswers += 1;
    return route.fulfill({ json: { readOnly: s.readOnly } });
  }
  // The snapshot is taken when the read starts, so a held read answers with what was true then.
  if (requestPath === "/api/all/beads") return answerList(route, s, structuredClone(mergedResponse(s)));
  const own = requestPath.match(/^\/api\/p\/([^/]+)\/beads$/);
  if (own) {
    const project = s.projects.find((p) => p.id === own[1]);
    const meta = { kind: project?.kind ?? "br", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 };
    return answerList(route, s, { beads: structuredClone(s.beads[own[1]] ?? []), meta });
  }
  if (requestPath.endsWith("/beads/stream")) return route.abort();
  const order = requestPath.match(/^\/api\/p\/([^/]+)\/order$/);
  if (order) return route.fulfill({ json: { orders: s.orders[order[1]] ?? {} } });
  if (requestPath.includes("/attachments/")) return route.fulfill({ body: PNG, contentType: "image/png" });
  if (requestPath === "/api/projects") {
    return route.fulfill({ json: { projects: s.projects.map((p) => ({ id: p.id, name: p.name, path: null, hasBeads: true })) } });
  }
  return route.fulfill({ json: {} });
}

function parseWrite(method, requestPath, raw) {
  const m = requestPath.match(/^\/api\/p\/([^/]+)\/(beads|attachments|order)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return {
    method, path: requestPath, raw, json, projectId: decodeURIComponent(m[1]), kind: m[2],
    own: m[3] && decodeURIComponent(m[3]), action: m[4],
  };
}

function createBead(s, w) {
  const id = `ab-${s.nextId++}`;
  const input = w.json;
  const bead = {
    id, title: input.title, description: input.description ?? "", status: input.backlog ? "deferred" : "open",
    priority: input.priority ?? 2, issue_type: input.issue_type ?? "task", assignee: input.assignee ?? "",
    labels: input.labels ?? [], comments: [], created_by: "reviewer", created_at: T, updated_at: T,
    dependencies: input.parent ? [dep(id, input.parent, "parent-child")] : [],
    ...(input.parent ? { parent: input.parent } : {}),
  };
  s.beads[w.projectId].push(bead);
  return bead;
}

// What the server would answer, applied to the fixture so later reads and answers agree with it.
function applyWrite(s, w) {
  if (w.kind === "attachments" && !w.own && w.method === "PUT") return { moved: true };
  if (w.kind === "attachments" && !w.own && w.method === "POST") {
    // The upload names its folder: the form's draft, until the bead exists.
    const folder = /name="beadId"\r\n\r\n([^\r\n]+)/.exec(w.raw)?.[1];
    if (!folder) return undefined;
    return { ref: `attachment://${folder}/shot.png`, url: `/api/p/${w.projectId}/attachments/${folder}/shot.png`, name: "shot.png" };
  }
  if (w.kind === "order" && !w.own && w.method === "PUT") {
    s.orders[w.projectId] = { ...(s.orders[w.projectId] ?? {}), [w.json.columnId]: w.json.ids };
    return { orders: s.orders[w.projectId] };
  }
  if (w.kind !== "beads") return undefined;
  if (!w.own && w.method === "POST") return createBead(s, w);
  const bead = s.beads[w.projectId].find((b) => b.id === w.own);
  if (!bead) return undefined;
  const body = w.json ?? {};
  if (!w.action && w.method === "PATCH") {
    for (const key of ["title", "description", "priority", "assignee", "labels"]) if (key in body) bead[key] = body[key];
    return bead;
  }
  if (w.action === "status" && w.method === "POST") {
    bead.status = body.status;
    return bead;
  }
  return undefined;
}

async function answerWrite(route, s, request, method, requestPath) {
  const buffer = request.postDataBuffer();
  const raw = buffer ? buffer.toString("latin1") : "";
  const w = parseWrite(method, requestPath, raw);
  if (!w || !s.beads[w.projectId]) {
    s.unexpected.push(`${method} ${requestPath}`);
    return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${requestPath}` } });
  }
  s.writes.push(w);
  if (s.holdWrites?.(w)) {
    const decision = await new Promise((resolve) => s.heldWrites.push({ write: w, resolve }));
    if (decision.refuse) return route.fulfill({ status: 400, json: { error: decision.refuse } }).catch(() => {});
  }
  const answer = applyWrite(s, w);
  if (answer === undefined) {
    s.unexpected.push(`${method} ${requestPath} (no such bead or action)`);
    return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${requestPath}` } });
  }
  return route.fulfill({ json: structuredClone(answer) }).catch(() => {});
}

async function openScenario({ url = "/all", projects = [alpha, beta], failed = [], readOnly = false, holdMode = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  state = {
    projects, failed, readOnly, viewerAnswers: 0,
    beads: Object.fromEntries(projects.map((p) => [p.id, p === alpha || p === beta ? seedBeads(p) : []])),
    orders: {}, listFetches: 0, listAnswered: 0, heldLists: [],
    holdWrites: null, heldWrites: [], writes: [], claimed: 0, unexpected: [],
    pendingChange: false, nextId: 10,
  };
  if (holdMode) state.modeGate = new Promise((resolve) => (state.releaseMode = resolve));
  const s = state;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const address = new URL(request.url());
    const requestPath = address.pathname;
    const buffer = request.postDataBuffer();
    allRequests.push({ method, path: `${address.pathname}${address.search}`, body: buffer ? buffer.toString("latin1") : "" });
    if (requestPath === "/api/all/beads/stream") {
      // A finished response makes EventSource reconnect after `retry`; a change set by the test
      // rides on the next reconnect.
      let body = "retry: 200\n: connected\n\n";
      if (s.pendingChange) {
        s.pendingChange = false;
        body += "event: change\ndata: {}\n\n";
      }
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body });
    }
    if (method === "GET") return answerRead(route, s, requestPath);
    return answerWrite(route, s, request, method, requestPath);
  });
  await page.goto(`${base}${url}`);
}

async function closeScenario() {
  assert.equal(state.writes.length, state.claimed, `${step}: every write was claimed by a step`);
  assert.deepEqual(state.unexpected, [], `${step}: no unexpected request`);
  for (const resolve of state.heldLists.splice(0)) resolve();
  await page.context().close();
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

// Takes the next writes the page sent and compares them, in order, with what the step expects:
// [method, path, fields of the JSON body]. Every write of a scenario has to be claimed by a step.
async function claim(label, expected) {
  step = label;
  await eventually(() => state.writes.length >= state.claimed + expected.length || state.unexpected.length > 0, `${label}: ${expected.length} request(s) sent`);
  await page.waitForTimeout(150);
  assert.deepEqual(state.unexpected, [], `${label}: no unexpected request`);
  const got = state.writes.slice(state.claimed);
  const shown = JSON.stringify(got.map((w) => `${w.method} ${w.path}`));
  assert.equal(got.length, expected.length, `${label}: exactly ${expected.length} request(s), got ${shown}`);
  expected.forEach(([method, requestPath, fields = {}], i) => {
    assert.equal(`${got[i].method} ${got[i].path}`, `${method} ${requestPath}`, `${label}: request ${i + 1}`);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(got[i].json?.[key], value, `${label}: ${key} in the body`);
  });
  state.claimed += got.length;
  return got;
}

async function expectWrites(label, action, expected) {
  await action();
  return claim(label, expected);
}

// Answers the first held write, or the last; a string refuses it with that message.
function release(refusal, which = "first") {
  const held = which === "last" ? state.heldWrites.pop() : state.heldWrites.shift();
  assert.ok(held, "a write is held");
  held.resolve(refusal === undefined ? {} : { refuse: refusal });
}

// The viewer mode has to have arrived and been rendered, or the page is read-only anyway.
async function modeArrived(after = 0) {
  await eventually(() => state.viewerAnswers > after, "the viewer mode answered");
  await page.waitForTimeout(300);
}

async function setMode(readOnly) {
  const answered = state.viewerAnswers;
  state.readOnly = readOnly;
  // The hook refetches on this channel's message, so the test need not wait for its interval.
  await page.evaluate(() => {
    const channel = new BroadcastChannel("scotty-viewer-mode");
    channel.postMessage("changed");
    channel.close();
  });
  await modeArrived(answered);
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const drawer = () => page.locator("[data-bead-drawer]");
const banner = () => page.getByRole("button", { name: "Read Only Mode", exact: true });
const newButton = (name = "New") => page.getByRole("button", { name, exact: true });
const chooser = () => page.getByRole("dialog").filter({ hasText: "Which project is it for?" });
const form = () => page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Create bead" }) });
const formHeading = async () => (await form().getByRole("heading").innerText()).trim();
const addChild = (epicId) => page.locator(`[data-epic-id="${epicId}"]`).getByRole("button", { name: "Add child to this epic" });
const columnOf = (id) => card(id).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
// A list row's group is the header above it.
const groupOf = (id) =>
  card(id).evaluate((el) => {
    for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
      if (!node.hasAttribute("data-keyboard-bead-id")) return node.querySelector("span.uppercase")?.textContent ?? null;
    }
    return null;
  });
const choicesOf = () =>
  chooser().locator("button[value]").evaluateAll((buttons) => buttons.map((b) => ({ value: b.value, label: b.textContent.trim() })));

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

// A real drag: press, move a little so the sensor starts it, travel in steps, then release. The
// card being dragged is dimmed in place, which says the press found the card it was aimed at.
async function pickUp(id, { inert = false } = {}) {
  const from = await centerOf(card(id));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
  if (inert) return;
  await eventually(async () => (await card(id).evaluate((el) => getComputedStyle(el).opacity)) === "0.4", `${step}: ${id} is being dragged`);
}

async function moveTo(point) {
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.waitForTimeout(150);
}

async function dragTo(id, point, options) {
  await pickUp(id, options);
  await moveTo(point);
  await page.mouse.up();
}

// Locates the next address the way the page's own controls do, without a new read of the list.
async function goAddress(url) {
  await page.evaluate((next) => window.history.pushState(null, "", next), url);
  const view = new URL(url, base).searchParams.get("view");
  const title = view === "list" ? "List" : view === "epics" ? "Epics" : "Board";
  await page.locator("main header h1", { hasText: title }).waitFor();
  await page.waitForTimeout(100);
}

async function closeStep() {
  await chooser().getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser().waitFor({ state: "detached" });
}

async function cancelForm() {
  await form().getByRole("button", { name: "Cancel", exact: true }).click();
  await form().waitFor({ state: "detached" });
}

// The mounted form is the only dialog, and nothing in it offers a project.
async function noProjectControl(label) {
  assert.equal(await page.getByRole("dialog").count(), 1, `${label}: the form is the only dialog`);
  assert.equal(await page.locator("button[value]").count(), 0, `${label}: no project choice is on screen`);
  const offered = await form().locator("option, button").evaluateAll((nodes) => nodes.map((n) => `${n.value ?? ""}|${n.textContent.trim()}`));
  const names = [alpha, beta, gamma, delta].flatMap((p) => [p.id, p.name]);
  const stray = offered.filter((entry) => entry.split("|").some((part) => names.includes(part)));
  assert.deepEqual(stray, [], `${label}: no control of the form names a project`);
}

async function projectPage() {
  // A project's own page: a drag between columns goes to that project with the plain id, and a
  // drag inside a group of its list still writes the order.
  step = "project page board";
  await openScenario({ url: "/p/alpha?view=board" });
  await card("ab-1").waitFor();
  await modeArrived();
  await dragTo("ab-1", await dropPoint("In Progress"));
  await claim("project page: a drag between columns", [["POST", "/api/p/alpha/beads/ab-1/status", { status: "in_progress" }]]);
  await eventually(async () => (await columnOf("ab-1")) === "In Progress", "project page: the card moved");
  await closeScenario();

  step = "project page list";
  await openScenario({ url: "/p/alpha?view=list" });
  await card("ab-1").waitFor();
  await modeArrived();
  await dragTo("ab-1", await centerOf(card("ab-2")));
  await claim("project page: a drag inside a group of the list", [["PUT", "/api/p/alpha/order", { columnId: "ready", ids: ["ab-2", "ab-1"] }]]);
  await closeScenario();
}

async function mergedBoard() {
  step = "merged board";
  await openScenario();
  await card("beta:ab-1").waitFor();
  await modeArrived();
  assert.equal(await banner().count(), 0, "editing mode: no banner");
  await newButton().waitFor();

  await dragTo("beta:ab-1", await dropPoint("In Progress"));
  await claim("board: beta's ab-1 to In Progress", [["POST", "/api/p/beta/beads/ab-1/status", { status: "in_progress" }]]);
  await eventually(async () => (await columnOf("beta:ab-1")) === "In Progress", "board: beta's ab-1 is in In Progress");
  assert.equal(await columnOf("alpha:ab-1"), "Ready", "board: alpha's ab-1 stays in Ready");

  // Refused because a blocker is open: the message shows and the card goes back. Every read of
  // the list after the first is held, so only the status write can have moved it either way.
  state.holdWrites = (w) => w.action === "status";
  await dragTo("beta:ab-2", await dropPoint("In Progress"));
  await eventually(() => state.heldWrites.length === 1, "board: the drag was sent");
  await eventually(async () => (await columnOf("beta:ab-2")) === "In Progress", "board: the card moves before the answer");
  release(BLOCKED);
  await claim("board: a refused drag", [["POST", "/api/p/beta/beads/ab-2/status", { status: "in_progress" }]]);
  await page.getByText(BLOCKED).first().waitFor();
  await eventually(async () => (await columnOf("beta:ab-2")) === "Ready", "board: the refused card is back in Ready");
  assert.equal(await columnOf("alpha:ab-2"), "Ready", "board: alpha's ab-2 did not move");

  // A second drag of the same card waits for the first to be answered, and wins.
  step = "board: two drags of one card";
  await dragTo("beta:ab-2", await dropPoint("In Progress"));
  await eventually(() => state.heldWrites.length === 1, "board: the first drag was sent");
  await eventually(async () => (await columnOf("beta:ab-2")) === "In Progress", "board: the card shows the first drop");
  await dragTo("beta:ab-2", await dropPoint("Backlog"));
  await page.waitForTimeout(300);
  assert.equal(state.writes.length, state.claimed + 1, "board: the second drag sends nothing while the first is held");
  await eventually(async () => (await columnOf("beta:ab-2")) === "Backlog", "board: the card shows the second drop at once");
  release();
  await eventually(() => state.heldWrites.length === 1, "board: the second drag went out once the first was answered");
  assert.equal(await columnOf("beta:ab-2"), "Backlog", "board: the first answer leaves the second drop in place");
  release();
  await claim("board: two drags of one card", [
    ["POST", "/api/p/beta/beads/ab-2/status", { status: "in_progress" }],
    ["POST", "/api/p/beta/beads/ab-2/status", { status: "deferred" }],
  ]);
  await page.waitForTimeout(300);
  assert.equal(await columnOf("beta:ab-2"), "Backlog", "board: the card ends in the column of the second drop");

  // Two cards, twins of one own id in two projects: neither write waits for the other.
  step = "board: two cards";
  await dragTo("alpha:ab-1", await dropPoint("In Progress"));
  await eventually(() => state.heldWrites.length === 1, "board: alpha's drag was sent");
  await dragTo("beta:ab-1", await dropPoint("Ready"));
  await eventually(() => state.heldWrites.length === 2, "board: beta's drag was sent while alpha's was held");
  release(undefined, "last");
  release();
  await claim("board: two cards", [
    ["POST", "/api/p/alpha/beads/ab-1/status", { status: "in_progress" }],
    ["POST", "/api/p/beta/beads/ab-1/status", { status: "open" }],
  ]);
  await eventually(
    async () => (await columnOf("alpha:ab-1")) === "In Progress" && (await columnOf("beta:ab-1")) === "Ready",
    "board: both cards end where they were dropped",
  );

  // A label answered while the drag is held must survive the drag's refusal.
  step = "board: a label during a refused drag";
  await dragTo("beta:ab-3", await dropPoint("Ready"));
  await eventually(() => state.heldWrites.length === 1, "board: the drag was sent");
  await card("beta:ab-3").click();
  await drawer().getByRole("heading", { name: "Beta three", exact: true }).waitFor();
  await drawer().getByLabel("Add label", { exact: true }).fill("urgent");
  await drawer().getByLabel("Add label", { exact: true }).press("Enter");
  await claim("board: a label change while the drag is held", [
    ["POST", "/api/p/beta/beads/ab-3/status", { status: "open" }],
    ["PATCH", "/api/p/beta/beads/ab-3", { labels: ["urgent"] }],
  ]);
  await drawer().getByRole("button", { name: "Remove label urgent", exact: true }).waitFor();
  await drawer().getByTitle("Close", { exact: true }).click();
  await drawer().waitFor({ state: "hidden" });
  assert.equal(await columnOf("beta:ab-3"), "Ready", "board: the label's answer leaves the dragged card where it was dropped");
  release("Cannot start ab-3: it is blocked by ab-8");
  await eventually(async () => (await columnOf("beta:ab-3")) === "In Progress", "board: the refused card is back in In Progress");
  await page.waitForTimeout(300);
  assert.equal(await card("beta:ab-3").getByText("urgent", { exact: true }).count(), 1, "board: the new label stays on the card");
  assert.equal(await card("alpha:ab-3").getByText("urgent", { exact: true }).count(), 0, "board: alpha's twin has no new label");
  state.holdWrites = null;
  assert.equal(state.listAnswered, 1, "board: every change showed while the later reads of the list stayed held");

  // A tracker's own write makes the page read every project again, and that read can answer with
  // the status from before the write while the write is still on its way. It must not send the
  // card back, and a drop made then must still count as a move to another column.
  step = "board: a read during a drag";
  state.holdWrites = (w) => w.action === "status";
  await dragTo("alpha:ab-2", await dropPoint("In Progress"));
  await eventually(() => state.heldWrites.length === 1, "board: the drag was sent");
  await eventually(async () => (await columnOf("alpha:ab-2")) === "In Progress", "board: the card moved before the answer");
  const fetched = state.listFetches;
  state.pendingChange = true;
  await eventually(() => state.listFetches > fetched, "board: the stream started a read after the drag");
  const answered = state.listAnswered;
  for (const resolve of state.heldLists.splice(0)) resolve();
  await eventually(() => state.listAnswered > answered, "board: that read was answered with the status from before the drag");
  await page.waitForTimeout(400);
  assert.equal(await columnOf("alpha:ab-2"), "In Progress", "board: a read answered during the write does not send the card back");
  await dragTo("alpha:ab-2", await dropPoint("Backlog"));
  await eventually(async () => (await columnOf("alpha:ab-2")) === "Backlog", "board: the card shows the second drop");
  const fetchedAgain = state.listFetches;
  state.pendingChange = true;
  await eventually(() => state.listFetches > fetchedAgain, "board: the stream started another read");
  const answeredAgain = state.listAnswered;
  for (const resolve of state.heldLists.splice(0)) resolve();
  await eventually(() => state.listAnswered > answeredAgain, "board: that read was answered too");
  await page.waitForTimeout(400);
  assert.equal(await columnOf("alpha:ab-2"), "Backlog", "board: a read answered while two writes wait leaves the card on the second drop");
  release();
  await eventually(() => state.heldWrites.length === 1, "board: the drop made after that read went out as a second write");
  release();
  await claim("board: a read during a drag", [
    ["POST", "/api/p/alpha/beads/ab-2/status", { status: "in_progress" }],
    ["POST", "/api/p/alpha/beads/ab-2/status", { status: "deferred" }],
  ]);
  await eventually(async () => (await columnOf("alpha:ab-2")) === "Backlog", "board: the card ends in the column of the second drop");
  state.holdWrites = null;
  await closeScenario();
}

async function mergedList() {
  step = "merged list";
  await openScenario({ url: "/all?view=list" });
  await card("beta:ab-1").waitFor();
  await modeArrived();
  await dragTo("beta:ab-1", await centerOf(card("beta:ab-3")));
  await claim("list: beta's ab-1 to In Progress", [["POST", "/api/p/beta/beads/ab-1/status", { status: "in_progress" }]]);
  await eventually(async () => (await groupOf("beta:ab-1")) === "In Progress", "list: beta's ab-1 is in In Progress");
  assert.equal(await groupOf("alpha:ab-1"), "Ready", "list: alpha's ab-1 stays in Ready");

  state.holdWrites = (w) => w.action === "status";
  await dragTo("beta:ab-2", await centerOf(card("alpha:ab-3")));
  await eventually(() => state.heldWrites.length === 1, "list: the drag was sent");
  await eventually(async () => (await groupOf("beta:ab-2")) === "In Progress", "list: the row moves before the answer");
  release(BLOCKED);
  await claim("list: a refused drag", [["POST", "/api/p/beta/beads/ab-2/status", { status: "in_progress" }]]);
  await page.getByText(BLOCKED).first().waitFor();
  await eventually(async () => (await groupOf("beta:ab-2")) === "Ready", "list: the refused row is back in Ready");
  assert.equal(await groupOf("alpha:ab-2"), "Ready", "list: alpha's ab-2 did not move");
  state.holdWrites = null;

  // This page has no order: the other rows of a group do not make room, and a drop writes none.
  step = "list: a drag inside one group";
  const others = ["alpha:ab-2", "beta:ab-2"];
  for (const id of others) assert.equal(await groupOf(id), "Ready", `list: ${id} shares the group`);
  const target = await centerOf(card("beta:ab-2"));
  const before = [];
  for (const id of others) before.push((await centerOf(card(id))).y);
  await pickUp("alpha:ab-1");
  await moveTo(target);
  await page.waitForTimeout(300);
  const during = await Promise.all(others.map(async (id) => (await centerOf(card(id))).y));
  others.forEach((id, i) => assert.ok(Math.abs(during[i] - before[i]) < 1, `list: ${id} keeps its place (${before[i]} -> ${during[i]})`));
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.deepEqual(state.unexpected, [], "list: a drop inside a group sends nothing unexpected");
  assert.equal(state.writes.length, state.claimed, "list: a drop inside a group sends nothing");
  assert.equal(await groupOf("alpha:ab-1"), "Ready", "list: the row stays in its group");
  await closeScenario();
}

async function createFlows() {
  step = "create: the step";
  await openScenario({ projects: [alpha, beta, delta], failed: [omega] });
  await card("beta:ab-1").waitFor();
  await modeArrived();
  await page.getByRole("alert").filter({ hasText: "Omega Down" }).waitFor();
  await newButton().click();
  await chooser().waitFor();
  assert.equal(await form().count(), 0, "no form before a project is chosen");
  assert.deepEqual(
    await choicesOf(),
    [{ value: "alpha", label: "Alpha App" }, { value: "beta", label: "Beta Tools" }, { value: "delta", label: "Delta Empty" }],
    "the step lists every project that was read, the empty one included, and not the one that failed",
  );
  await chooser().getByRole("button", { name: "Beta Tools", exact: true }).click();
  await form().waitFor();
  assert.equal(await chooser().count(), 0, "the form replaced the step");
  assert.equal(await formHeading(), "New bead in Beta Tools", "the form says where it writes");
  await noProjectControl("the form for beta");
  await cancelForm();
  await newButton().click();
  await chooser().waitFor();
  assert.equal(await form().count(), 0, "after Cancel, the next New opens the step again");
  await closeStep();

  // The filter comes from the address unchecked; only one project that was read presets it, and
  // the epics view never does.
  const unset = ["", "project=alpha&project=beta", "project=zeta", "project=%40all"];
  const cases = [
    ...unset.map((q) => ["", q, "New"]),
    ...unset.map((q) => ["view=list", q, "New"]),
    ...[...unset, "project=beta"].map((q) => ["view=epics", q, "New epic"]),
  ];
  for (const [view, query, button] of cases) {
    const url = `/all?${[view, query].filter(Boolean).join("&")}`;
    step = `create: the step on ${url}`;
    await goAddress(url);
    await newButton(button).click();
    await chooser().waitFor();
    assert.equal(await form().count(), 0, `${url}: no form before a project is chosen`);
    await closeStep();
  }
  for (const url of ["/all?project=beta", "/all?view=list&project=beta"]) {
    step = `create: preset on ${url}`;
    await goAddress(url);
    await newButton().click();
    await form().waitFor();
    assert.equal(await chooser().count(), 0, `${url}: no step`);
    assert.equal(await formHeading(), "New bead in Beta Tools", `${url}: the form is for beta`);
    await cancelForm();
  }

  // New epic keeps its type through the step: the step says what is being created, and the bead
  // created is an epic.
  step = "create: a new epic";
  await goAddress("/all?view=epics");
  await newButton("New epic").click();
  await chooser().waitFor();
  assert.equal((await chooser().getByRole("heading").innerText()).trim(), "New epic", "the step names what is being created");
  await chooser().getByRole("button", { name: "Beta Tools", exact: true }).click();
  await form().waitFor();
  assert.equal(await formHeading(), "New epic in Beta Tools", "the form is for an epic in beta");
  await form().getByPlaceholder("What needs doing?").fill("Beta second epic");
  await expectWrites("new epic: create", () => form().getByRole("button", { name: "Create bead" }).click(), [
    ["POST", "/api/p/beta/beads", { title: "Beta second epic", issue_type: "epic" }],
  ]);
  await form().waitFor({ state: "detached" });

  step = "create: add child to beta's epic";
  await goAddress("/all?view=epics");
  await card("beta:e-1").click();
  await addChild("beta:e-1").click();
  await form().waitFor();
  assert.equal(await chooser().count(), 0, "add child: no step");
  assert.equal(await formHeading(), "New child bead in Beta Tools", "add child: the form is for beta");
  assert.equal(await form().getByPlaceholder("No parent — type to search…").inputValue(), "e-1 · Beta epic", "add child: the parent is beta's epic");
  await form().getByPlaceholder("What needs doing?").fill("Beta child");
  await expectWrites("add child: create", () => form().getByRole("button", { name: "Create bead" }).click(), [
    ["POST", "/api/p/beta/beads", { title: "Beta child", parent: "e-1" }],
  ]);
  await form().waitFor({ state: "detached" });

  // An empty project can be chosen and written to. A read of the list started first stays held,
  // so the new card can only come from the create's answer.
  step = "create: a project with no bead";
  await goAddress("/all");
  const fetched = state.listFetches;
  state.pendingChange = true;
  await eventually(() => state.listFetches > fetched, "the stream started a new read of the list");
  const answered = state.listAnswered;
  await newButton().click();
  await chooser().getByRole("button", { name: "Delta Empty", exact: true }).click();
  await form().waitFor();
  assert.equal(await formHeading(), "New bead in Delta Empty", "the form is for delta");
  await form().getByPlaceholder("What needs doing?").fill("Delta first");
  await expectWrites("create in delta", () => form().getByRole("button", { name: "Create bead" }).click(), [
    ["POST", "/api/p/delta/beads", { title: "Delta first" }],
  ]);
  await form().waitFor({ state: "detached" });
  await card(`delta:${state.beads.delta[0].id}`).waitFor();
  assert.ok(state.heldLists.length > 0, "the read started before the create is still held");
  assert.equal(state.listAnswered, answered, "the new card is on the board with no later read answered");
  await closeScenario();

  step = "create: two projects named alike";
  await openScenario({ projects: [alpha, beta, gamma] });
  await card("beta:ab-1").waitFor();
  await modeArrived();
  await newButton().click();
  await chooser().waitFor();
  assert.deepEqual(
    await choicesOf(),
    [{ value: "alpha", label: "Alpha App" }, { value: "beta", label: "Beta Tools (beta)" }, { value: "gamma", label: "Beta Tools (gamma)" }],
    "each of two projects named alike shows its id",
  );
  await chooser().getByRole("button", { name: "Beta Tools (gamma)", exact: true }).click();
  await form().waitFor();
  assert.equal(await formHeading(), "New bead in Beta Tools (gamma)", "the form is for gamma");
  await noProjectControl("the form for gamma");
  const [upload] = await expectWrites(
    "image: the draft upload",
    () => form().locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG }),
    [["POST", "/api/p/gamma/attachments"]],
  );
  const draft = /name="beadId"\r\n\r\n([^\r\n]+)/.exec(upload.raw)?.[1] ?? "";
  assert.match(draft, /^draft-/, "the image goes to the form's draft");
  await eventually(
    async () => (await form().getByPlaceholder(/^Optional details/).inputValue()).includes(`attachment://${draft}/shot.png`),
    "the image is in the description",
  );
  await form().getByPlaceholder("What needs doing?").fill("Gamma with image");
  const created = `ab-${state.nextId}`;
  const [, , rewrite] = await expectWrites("image: the create", () => form().getByRole("button", { name: "Create bead" }).click(), [
    ["POST", "/api/p/gamma/beads", { title: "Gamma with image" }],
    ["PUT", "/api/p/gamma/attachments", { draftId: draft, beadId: created }],
    ["PATCH", `/api/p/gamma/beads/${created}`],
  ]);
  assert.ok(rewrite.json.description.includes(`attachment://${created}/shot.png`), "the description names the bead's own folder");
  assert.ok(!rewrite.json.description.includes(draft), "and no longer the draft");
  await form().waitFor({ state: "detached" });
  await card(`gamma:${created}`).waitFor();
  assert.equal(state.beads.beta.length, 4, "beta, named alike, received nothing");
  await closeScenario();

  step = "create: no project to list";
  await openScenario({ projects: [], failed: [omega] });
  await modeArrived();
  await page.getByRole("alert").filter({ hasText: "Omega Down" }).waitFor();
  await newButton().click();
  await chooser().waitFor();
  await chooser().getByText("No project could be read").waitFor();
  const controls = await chooser().getByRole("button").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label") || n.textContent.trim()));
  assert.deepEqual(controls, ["Close", "Cancel"], "with no project the step offers nothing to submit");
  await closeStep();
  await closeScenario();
}

async function readOnlyPage() {
  step = "read-only";
  await openScenario({ readOnly: true });
  await card("beta:ab-1").waitFor();
  await modeArrived();
  await banner().waitFor();
  assert.equal(await newButton().count(), 0, "read-only: the board has no New");
  await dragTo("beta:ab-1", await dropPoint("In Progress"), { inert: true });
  await page.waitForTimeout(400);
  assert.equal(await columnOf("beta:ab-1"), "Ready", "read-only: a card cannot be dragged on the board");
  await goAddress("/all?view=list");
  assert.equal(await newButton().count(), 0, "read-only: the list has no New");
  await dragTo("beta:ab-1", await centerOf(card("beta:ab-3")), { inert: true });
  await page.waitForTimeout(400);
  assert.equal(await groupOf("beta:ab-1"), "Ready", "read-only: a row cannot be dragged in the list");
  await goAddress("/all?view=epics");
  await card("beta:e-1").click();
  assert.equal(await newButton("New epic").isDisabled(), true, "read-only: New epic is disabled");
  assert.equal(await addChild("beta:e-1").isDisabled(), true, "read-only: Add child is disabled");
  await newButton("New epic").click({ force: true });
  await addChild("beta:e-1").click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole("dialog").count(), 0, "read-only: nothing opens");
  assert.equal(state.writes.length, 0, "read-only: no non-GET was sent");
  assert.deepEqual(state.unexpected, [], "read-only: nothing unexpected was sent");

  // The same gestures act once the mode says editing, so the checks above could have failed.
  await setMode(false);
  await eventually(async () => (await banner().count()) === 0, "editing mode is back");
  assert.equal(await newButton("New epic").isDisabled(), false, "editing: New epic is enabled");
  await goAddress("/all");
  await newButton().waitFor();
  await dragTo("beta:ab-1", await dropPoint("In Progress"));
  await claim("editing again: the same drag", [["POST", "/api/p/beta/beads/ab-1/status", { status: "in_progress" }]]);
  await closeScenario();

  step = "before the viewer mode answers";
  await openScenario({ holdMode: true });
  await card("beta:ab-1").waitFor();
  await page.waitForTimeout(300);
  assert.equal(state.viewerAnswers, 0, "the viewer mode has not answered yet");
  assert.equal(await newButton().count(), 0, "no New until the mode is known");
  await dragTo("beta:ab-1", await dropPoint("In Progress"), { inert: true });
  await page.waitForTimeout(400);
  assert.equal(await columnOf("beta:ab-1"), "Ready", "no drag until the mode is known");
  assert.equal(state.writes.length, 0, "nothing was sent while the mode was unknown");
  state.releaseMode();
  await newButton().waitFor();
  await closeScenario();
}

async function fixtureHalf() {
  await projectPage();
  await mergedBoard();
  await mergedList();
  await createFlows();
  await readOnlyPage();
  step = "the requests of the fixture half";
  assert.ok(
    allRequests.some((r) => r.method === "POST" && r.body.includes('"title":"Delta first"')),
    "the recorder kept the bodies the scan below reads",
  );
  const named = allRequests.filter(namesForbidden);
  assert.deepEqual(named, [], "no request path or body names @all or a namespaced id");
}

// Two throwaway br trackers, the server's own routes, and the page exactly as a user gets it.
async function serverHalf() {
  const BR = process.env.BR_BIN || "br";
  try {
    execFileSync(BR, ["--version"], { stdio: "ignore" });
  } catch {
    console.log("SKIP real-server half: br is not installed");
    return false;
  }
  step = "real server";
  // cwd is always the throwaway folder: br resolves its tracker from there.
  const br = (dir, args) => execFileSync(BR, args, { cwd: dir, encoding: "utf8" });
  const statusEvents = (t) =>
    JSON.parse(br(t.dir, ["audit", "log", t.id, "--json"])).events
      .filter((e) => e.event_type === "status_changed")
      .sort((a, b) => a.id - b.id)
      .map((e) => `${e.old_value}->${e.new_value}`);
  const dirs = [];
  const registered = [];
  const context = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
  try {
    const tracker = (prefix, title) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scotty-page-${prefix}-`));
      dirs.push(dir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      br(dir, ["init", "--prefix", prefix]);
      return { dir, id: JSON.parse(br(dir, ["create", title, "--json"])).id };
    };
    const first = tracker("pa", "Page writes first");
    const second = tracker("pb", "Page writes second");
    for (const t of [first, second]) {
      const res = await fetch(`${base}/api/projects`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: t.dir }),
      });
      assert.equal(res.status, 201, `register ${t.dir}: ${await res.clone().text()}`);
      t.projectId = (await res.json()).id;
      registered.push(t.projectId);
    }
    const firstBefore = br(first.dir, ["show", first.id, "--json"]);

    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const sent = [];
    page.on("request", (r) => {
      const { pathname } = new URL(r.url());
      if (r.method() !== "GET") sent.push({ method: r.method(), path: pathname, body: r.postData() ?? "" });
    });
    const statusPath = `/api/p/${second.projectId}/beads/${second.id}/status`;
    const answers = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname === statusPath) answers.push(r.status());
    });
    const mode = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/viewer-mode");
    await page.goto(`${base}/all?project=${first.projectId}&project=${second.projectId}`);
    assert.equal((await (await mode).json()).readOnly, false, "this half writes through the API and needs an editing launch");
    const own = `${second.projectId}:${second.id}`;
    await card(own).waitFor();
    await card(`${first.projectId}:${first.id}`).waitFor();
    await newButton().waitFor();

    await dragTo(own, await dropPoint("In Progress"));
    await eventually(async () => (await columnOf(own)) === "In Progress", "real server: the card shows the first drop");
    await dragTo(own, await dropPoint("Ready"));
    await eventually(() => answers.length >= 2, "real server: both drags were answered", 15_000);
    assert.deepEqual(answers, [200, 200], "real server: both writes were accepted");
    await eventually(async () => (await columnOf(own)) === "Ready", "real server: the card ends in Ready");
    assert.deepEqual(
      sent.map((r) => `${r.method} ${r.path} ${r.body}`),
      [`POST ${statusPath} {"status":"in_progress"}`, `POST ${statusPath} {"status":"open"}`],
      "real server: the two drags sent two status writes to the second tracker, in order, and nothing else",
    );
    assert.equal(JSON.parse(br(second.dir, ["show", second.id, "--json"]))[0].status, "open", "br show: the bead ends open");
    assert.deepEqual(statusEvents(second), ["open->in_progress", "in_progress->open"], "br audit log: two status events, in order");
    assert.equal(br(first.dir, ["show", first.id, "--json"]), firstBefore, "br show: the first tracker's bead is unchanged");
    assert.deepEqual(statusEvents(first), [], "br audit log: the first tracker's bead has no status event");
    return true;
  } finally {
    await context.close();
    for (const id of registered) await fetch(`${base}/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  if (half !== "server") await fixtureHalf();
  const server = half !== "fixtures" ? await serverHalf() : false;
  console.log(
    `PASS: the all-projects page writes a drag to the bead's own project and id, asks which project a new bead ` +
      `is for, and is inert until the mode says editing (${allRequests.length} fixture requests checked` +
      `${server ? "; real server: two drags landed in the second tracker in order" : ""})`,
  );
} catch (error) {
  console.error(`Error at step "${step}": ${String(error?.message).split("\n")[0]}`);
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), writes: state?.writes.map((w) => `${w.method} ${w.path}`), unexpected: state?.unexpected, body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
