// The detail panel of the all-projects page at /all writes to the bead's own project under the
// bead's own id, shows each answer at once in the panel and on the card behind it, sends status
// changes to one bead one at a time, and stays inert in read-only mode. Every /api/ response comes
// from fixtures through page.route: they record each request, hold every read of the merged list
// after the first (so only an answer put into the cache can change the screen), can hold or refuse
// a chosen write, answer each write with the bead as changed, and fail on any non-GET they do not
// know. A few checks reach the page's query client and the board's status mutation through React's
// fiber tree, for what no control can show: a status call that names no project, and the moment a
// caller's own callback runs. They are marked "probe".
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App", kind: "br" };
const beta = { id: "beta", name: "Beta Tools", kind: "bd" };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const NO_PROJECT = "This status change names no project to send it to";
const REFUSED = "Refused by the fixture";
// Nothing that leaves the page may name the pseudo project or a namespaced id.
const FORBIDDEN = /(@|%40)all|alpha(:|%3a)|beta(:|%3a)/i;

const dep = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

// Both projects hold the same own ids: ab-1 depends on ab-2, ab-3 is a subtask of ab-1, ab-4
// depends on ab-1. Titles carry the project, so a list that mixes projects shows it.
function seedBeads(project) {
  const word = project.name.split(" ")[0];
  const own = (id, title, extra = {}) => ({
    id, title, description: "", status: "open", priority: 2, issue_type: "task", assignee: "",
    labels: [], comments: [], dependencies: [], created_by: "reviewer", created_at: T, updated_at: T,
    ...extra,
  });
  return [
    own("ab-1", `${word} one`, {
      description: "- [ ] first step", labels: ["keep"], dependencies: [dep("ab-1", "ab-2", "blocks")],
    }),
    own("ab-2", `${word} two`),
    own("ab-3", `${word} three`, { parent: "ab-1", dependencies: [dep("ab-3", "ab-1", "parent-child")] }),
    own("ab-4", `${word} four`, { dependencies: [dep("ab-4", "ab-1", "blocks")] }),
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
      kind: "all", readOnly: true, humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000,
      projects: s.projects.map((p) => ({ ...p, count: (s.beads[p.id] ?? []).length })),
      failed: [],
    },
  };
}

// The first read of a page is answered; every later one waits until the test lets it go.
async function answerList(route, s, json) {
  s.listFetches += 1;
  if (s.listFetches > 1) await new Promise((resolve) => s.heldLists.push(resolve));
  s.listAnswered += 1;
  return route.fulfill({ json });
}

async function answerRead(route, s, path) {
  if (path === "/api/viewer-mode") {
    if (s.modeGate) await s.modeGate;
    s.viewerAnswers += 1;
    return route.fulfill({ json: { readOnly: s.readOnly } });
  }
  // The snapshot is taken when the read starts, so a held read answers with what was true then.
  if (path === "/api/all/beads") return answerList(route, s, structuredClone(mergedResponse(s)));
  const own = path.match(/^\/api\/p\/([^/]+)\/beads$/);
  if (own) {
    const project = s.projects.find((p) => p.id === own[1]);
    const meta = { kind: project?.kind ?? "br", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 };
    return answerList(route, s, { beads: structuredClone(s.beads[own[1]] ?? []), meta });
  }
  if (path.endsWith("/beads/stream")) return route.abort();
  if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
  if (path.includes("/attachments/")) return route.fulfill({ status: 404, json: { error: "no image here" } });
  if (path === "/api/projects") {
    return route.fulfill({ json: { projects: s.projects.map((p) => ({ id: p.id, name: p.name, path: null, hasBeads: true })) } });
  }
  return route.fulfill({ json: {} });
}

function parseWrite(method, path, raw) {
  const m = path.match(/^\/api\/p\/([^/]+)\/(beads|attachments)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { method, path, raw, json, projectId: decodeURIComponent(m[1]), kind: m[2], own: m[3] && decodeURIComponent(m[3]), action: m[4] };
}

function closeBead(bead, reason) {
  bead.status = "closed";
  bead.closed_at = "2026-09-02T00:00:00Z";
  if (reason) bead.close_reason = reason;
}

// What the server would answer, applied to the fixture so later reads and answers agree with it.
function applyWrite(s, w) {
  const beads = s.beads[w.projectId];
  if (w.kind === "attachments" && w.method === "POST" && !w.own) {
    return { ref: "attachment://ab-1/shot.png", url: `/api/p/${w.projectId}/attachments/ab-1/shot.png`, name: "shot.png" };
  }
  if (w.kind !== "beads") return undefined;
  if (!w.own && w.method === "POST") {
    const id = `ab-${s.nextId++}`;
    const input = w.json;
    const bead = {
      id, title: input.title, description: input.description ?? "", status: input.backlog ? "deferred" : "open",
      priority: input.priority ?? 2, issue_type: input.issue_type ?? "task", assignee: input.assignee ?? "",
      labels: input.labels ?? [], comments: [], created_by: "reviewer", created_at: T, updated_at: T,
      dependencies: input.parent ? [dep(id, input.parent, "parent-child")] : [],
      ...(input.parent ? { parent: input.parent } : {}),
    };
    beads.push(bead);
    return bead;
  }
  const bead = beads.find((b) => b.id === w.own);
  if (!bead) return undefined;
  const body = w.json ?? {};
  if (!w.action && w.method === "DELETE") {
    beads.splice(beads.indexOf(bead), 1);
    return { deleted: bead.id };
  }
  if (!w.action && w.method === "PATCH") {
    for (const key of ["title", "description", "priority", "assignee", "labels"]) if (key in body) bead[key] = body[key];
    if (body.parent === "") {
      delete bead.parent;
      bead.dependencies = bead.dependencies.filter((d) => d.type !== "parent-child");
    }
    return bead;
  }
  if (w.action === "status" && w.method === "POST") {
    if (body.status === "closed") closeBead(bead, body.reason);
    else bead.status = body.status;
    return bead;
  }
  if (w.action === "comments" && w.method === "POST") {
    bead.comments.push({ id: `c-${bead.comments.length + 1}`, author: "reviewer", text: body.text, created_at: T });
    return bead;
  }
  if (w.action === "deps" && w.method === "POST") {
    bead.dependencies.push(dep(bead.id, body.depends_on_id, body.type));
    return bead;
  }
  if (w.action === "deps" && w.method === "DELETE") {
    bead.dependencies = bead.dependencies.filter((d) => d.depends_on_id !== body.depends_on_id);
    return bead;
  }
  if (w.action === "archive" && w.method === "POST") {
    closeBead(bead);
    bead.labels = [...bead.labels, "archived"];
    return bead;
  }
  if (w.action === "labels" && w.method === "POST") {
    bead.labels = [...bead.labels.filter((l) => !body.remove.includes(l)), ...body.add.filter((l) => !bead.labels.includes(l))];
    return bead;
  }
  if (w.action === "gate" && w.method === "POST") {
    // The route answers with the gate alone; the bead it blocks changes in the tracker only.
    const gate = {
      id: "ab-5", title: "Approval for ab-1", description: body.reason ?? "", status: "open", priority: 2,
      issue_type: "gate", await_type: "human", assignee: "", labels: [], comments: [], dependencies: [],
      created_by: "reviewer", created_at: T, updated_at: T,
    };
    beads.push(gate);
    bead.dependencies.push(dep(bead.id, gate.id, "blocks"));
    return gate;
  }
  if (w.action === "assist" && w.method === "POST") {
    return { description: "Refined by the assistant\n\n- [ ] refined step", acceptance: "", labels: [], duplicates: [] };
  }
  return undefined;
}

async function answerWrite(route, s, request, method, path) {
  const buffer = request.postDataBuffer();
  const raw = buffer ? buffer.toString("latin1") : "";
  const w = parseWrite(method, path, raw);
  if (!w || !s.beads[w.projectId]) {
    s.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${path}` } });
  }
  s.writes.push(w);
  if (s.holdWrites?.(w)) {
    const decision = await new Promise((resolve) => s.heldWrites.push({ write: w, resolve }));
    if (decision === "refuse") return route.fulfill({ status: 400, json: { error: REFUSED } });
  }
  const answer = applyWrite(s, w);
  if (answer === undefined) {
    s.unexpected.push(`${method} ${path} (no such bead or action)`);
    return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${path}` } });
  }
  return route.fulfill({ json: structuredClone(answer) });
}

async function openScenario({ url = "/all?done=all&archived=1", projects = [alpha, beta], holdMode = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1900, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  state = {
    projects,
    beads: Object.fromEntries([alpha, beta].filter((p) => projects.includes(p)).map((p) => [p.id, seedBeads(p)])),
    readOnly: false, viewerAnswers: 0,
    listFetches: 0, listAnswered: 0, heldLists: [],
    holdWrites: null, heldWrites: [], writes: [], claimed: 0, unexpected: [],
    pendingChange: false, nextId: 6,
  };
  if (holdMode) state.modeGate = new Promise((resolve) => (state.releaseMode = resolve));
  const s = state;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const buffer = request.postDataBuffer();
    allRequests.push({ method, path: `${url.pathname}${url.search}`, body: buffer ? buffer.toString("latin1") : "" });
    if (path === "/api/all/beads/stream") {
      // A finished response makes EventSource reconnect after `retry`; a change set by the test
      // rides on the next reconnect.
      let body = "retry: 200\n: connected\n\n";
      if (s.pendingChange) {
        s.pendingChange = false;
        body += "event: change\ndata: {}\n\n";
      }
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body });
    }
    if (method === "GET") return answerRead(route, s, path);
    return answerWrite(route, s, request, method, path);
  });
  await page.goto(`${base}${url}`);
  return { context };
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
// [method, path, fields of the JSON body]. Every write of the run has to be claimed by a step.
async function claim(label, expected) {
  step = label;
  await eventually(() => state.writes.length >= state.claimed + expected.length, `${label}: ${expected.length} request(s) sent`);
  await page.waitForTimeout(150);
  const got = state.writes.slice(state.claimed);
  const shown = JSON.stringify(got.map((w) => `${w.method} ${w.path}`));
  assert.equal(got.length, expected.length, `${label}: exactly ${expected.length} request(s), got ${shown}`);
  expected.forEach(([method, path, fields = {}], i) => {
    assert.equal(`${got[i].method} ${got[i].path}`, `${method} ${path}`, `${label}: request ${i + 1}`);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(got[i].json?.[key], value, `${label}: ${key} in the body`);
  });
  state.claimed += got.length;
  return got;
}

async function expectWrites(label, action, expected) {
  await action();
  return claim(label, expected);
}

const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
const drawer = () => page.locator("[data-bead-drawer]");
const createDialog = () => page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Create bead" }) });
const statusSelect = () => drawer().locator("select").nth(0);
const prioritySelect = () => drawer().locator("select").nth(1);
const banner = () => page.getByRole("button", { name: "Read Only Mode", exact: true });
const columnOf = (id) => card(id).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
const depRow = (id) => drawer().locator(`button[title="Open ${id}"]`);
const depRemove = (id) => depRow(id).locator("xpath=..").locator('button[title="remove"]');

async function openPanel(id, title) {
  await card(id).click();
  await drawer().getByRole("heading", { name: title, exact: true }).waitFor();
}

async function closePanel() {
  await drawer().getByTitle("Close", { exact: true }).click();
  await drawer().waitFor({ state: "hidden" });
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

function release(outcome) {
  const held = state.heldWrites.shift();
  assert.ok(held, "a write is held");
  held.resolve(outcome);
}

function releaseLists() {
  for (const resolve of state.heldLists.splice(0)) resolve();
}

// Probe: the query client and the board's status mutation, found from a card through React's
// fiber tree. The board calls useSetStatus before useSetOrder, so its first mutation with an
// onMutate is the status one; the first call below proves it by where it sends.
async function installProbe() {
  const found = await page.evaluate(() => {
    const host = document.querySelector("[data-keyboard-bead-id]");
    const key = Object.keys(host).find((k) => k.startsWith("__reactFiber$"));
    let client = null;
    let status = null;
    for (let fiber = host[key]; fiber; fiber = fiber.return) {
      if (!client && typeof fiber.memoizedProps?.client?.getQueryCache === "function") client = fiber.memoizedProps.client;
      if (status || typeof fiber.type !== "function") continue;
      for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
        const value = hook.memoizedState;
        if (value && typeof value.mutate === "function" && typeof value.options?.onMutate === "function") {
          status = value;
          break;
        }
      }
    }
    const order = [];
    window.__scottyProbe = { client, status, order };
    client?.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action?.type === "success" && event.query.queryHash === '["all-beads"]') {
        order.push(event.action.manual ? "list put" : "list read");
      }
    });
    client?.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action?.type === "success") order.push("mutation success");
    });
    return { client: !!client, status: !!status };
  });
  assert.deepEqual(found, { client: true, status: true }, "probe: found the query client and the board's status mutation");
}

const probeStatus = (vars) =>
  page.evaluate((v) => {
    void window.__scottyProbe.status.mutate(v).catch(() => {});
  }, vars);
const probeOwnStatus = (projectId, id) =>
  page.evaluate(([p, i]) => window.__scottyProbe.client.getQueryData(["beads", p])?.beads.find((b) => b.id === i)?.status, [projectId, id]);

// Two quick changes A then B of beta's ab-1, each held until the test answers it.
async function twoQuickChanges(label, [a, b], [outcomeA, outcomeB], expected, column) {
  step = label;
  const path = "/api/p/beta/beads/ab-1/status";
  state.holdWrites = (w) => w.action === "status";
  const fetched = state.listFetches;
  await statusSelect().selectOption(a);
  await eventually(() => state.heldWrites.length === 1, `${label}: the first change was sent`);
  await statusSelect().selectOption(b);
  await page.waitForTimeout(300);
  assert.equal(state.writes.length, state.claimed + 1, `${label}: the second change sends nothing while the first is held`);
  assert.equal(await statusSelect().inputValue(), b, `${label}: the panel shows the latest choice at once`);
  release(outcomeA);
  await eventually(() => state.heldWrites.length === 1, `${label}: the second change went out once the first was answered`);
  assert.equal(await statusSelect().inputValue(), b, `${label}: the first answer leaves the choice still on its way in place`);
  await claim(label, [["POST", path, { status: a }], ["POST", path, { status: b }]]);
  assert.equal(await statusSelect().inputValue(), b, `${label}: and it stays there until the second is answered`);
  release(outcomeB);
  await eventually(
    async () => (await statusSelect().inputValue()) === expected && (await columnOf("beta:ab-1")) === column,
    `${label}: ends on ${expected}`,
  );
  await page.waitForTimeout(300);
  assert.equal(await statusSelect().inputValue(), expected, `${label}: stays on ${expected}`);
  state.holdWrites = null;
  return state.listFetches > fetched;
}

try {
  // A project's own page: the status select changes at once, comes back on a refusal, and goes to
  // that project. Reads after the first are held, so only the hook can put the status back.
  step = "project page";
  await openScenario({ url: "/p/alpha?view=board" });
  await card("ab-2").waitFor();
  await modeArrived();
  await openPanel("ab-2", "Alpha two");
  state.holdWrites = (w) => w.action === "status";
  await statusSelect().selectOption("in_progress");
  await claim("project page: status", [["POST", "/api/p/alpha/beads/ab-2/status", { status: "in_progress" }]]);
  await eventually(
    async () => (await statusSelect().inputValue()) === "in_progress" && (await columnOf("ab-2")) === "In Progress",
    "project page: the status changes before the answer",
  );
  release("refuse");
  await eventually(
    async () => (await statusSelect().inputValue()) === "open" && (await columnOf("ab-2")) === "Ready",
    "project page: a refusal puts the status back",
  );
  await page.getByText(REFUSED).first().waitFor();
  assert.deepEqual(state.unexpected, [], "no unexpected request on the project page");
  releaseLists();
  await page.context().close();

  step = "merged board";
  await openScenario();
  await card("beta:ab-1").waitFor();
  await modeArrived();
  assert.equal(state.listAnswered, 1, "one read of the merged list was answered");

  // Probe: a status write naming its project goes there, patches that project's own cache and the
  // merged list at once, and both come back on a refusal, with a fresh read of the merged list.
  step = "probe: status with a project";
  await installProbe();
  await page.evaluate(() => {
    window.__scottyProbe.client.setQueryData(["beads", "beta"], {
      beads: [{ id: "ab-2", title: "Beta two", status: "open", priority: 2, issue_type: "task", labels: [], dependencies: [], comments: [] }],
      meta: { kind: "bd", humanActor: "reviewer", humanAllowlist: [], pollIntervalMs: 300_000 },
    });
  });
  state.holdWrites = (w) => w.action === "status";
  {
    const fetched = state.listFetches;
    await probeStatus({ id: "ab-2", status: "in_progress", projectId: "beta" });
    await claim("probe: status with a project", [["POST", "/api/p/beta/beads/ab-2/status", { status: "in_progress" }]]);
    assert.equal(await probeOwnStatus("beta", "ab-2"), "in_progress", "probe: beta's own cache is patched before the answer");
    await eventually(async () => (await columnOf("beta:ab-2")) === "In Progress", "the card moved before the answer");
    assert.equal(await columnOf("alpha:ab-2"), "Ready", "the twin in alpha did not move");
    release("refuse");
    await eventually(async () => (await columnOf("beta:ab-2")) === "Ready", "the refused change is undone on the board");
    assert.equal(await probeOwnStatus("beta", "ab-2"), "open", "probe: beta's own cache is restored");
    await eventually(() => state.listFetches > fetched, "a refusal asks for a fresh read of the merged list");
    await page.getByText(REFUSED).first().waitFor();
  }
  state.holdWrites = null;

  // Probe: the board's own context is the pseudo project, which is refused before any request.
  step = "status with the page's own pseudo project";
  await probeStatus({ id: "ab-2", status: "in_progress" });
  await page.waitForTimeout(400);
  assert.equal(state.writes.length, state.claimed, "a status change with no project sends nothing");
  assert.deepEqual(state.unexpected, [], "nothing unexpected was sent");
  await page.getByText(NO_PROJECT).first().waitFor();
  assert.equal(await columnOf("beta:ab-2"), "Ready", "and changes nothing on the board");

  // Beta's ab-1: every control of the panel, each write to beta under the own id, each answer shown.
  step = "open beta's ab-1";
  await openPanel("beta:ab-1", "Beta one");
  await expectWrites("status select", () => statusSelect().selectOption("in_progress"), [
    ["POST", "/api/p/beta/beads/ab-1/status", { status: "in_progress" }],
  ]);
  await eventually(
    async () => (await statusSelect().inputValue()) === "in_progress" && (await columnOf("beta:ab-1")) === "In Progress",
    "the status shows in the panel and the card is in its new column",
  );
  assert.equal(await columnOf("alpha:ab-1"), "Blocked", "the twin in alpha stays where it was");

  await expectWrites("priority", () => prioritySelect().selectOption("0"), [["PATCH", "/api/p/beta/beads/ab-1", { priority: 0 }]]);
  await eventually(async () => (await prioritySelect().inputValue()) === "0", "the panel shows the new priority");

  await drawer().getByRole("button", { name: "Change assignee" }).click();
  await drawer().getByLabel("Assignee", { exact: true }).fill("dana");
  await expectWrites("assignee", () => drawer().getByLabel("Assignee", { exact: true }).press("Enter"), [
    ["PATCH", "/api/p/beta/beads/ab-1", { assignee: "dana" }],
  ]);
  await eventually(async () => (await drawer().getByRole("button", { name: "Change assignee" }).innerText()).includes("dana"), "the panel shows the assignee");

  await drawer().getByTitle("Edit title & description").click();
  await drawer().getByPlaceholder("Title", { exact: true }).fill("Beta one renamed");
  await drawer().getByPlaceholder("Describe this bead…").fill("- [ ] first step\n- [ ] second step");
  await expectWrites(
    "attach an image",
    () => drawer().locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG }),
    [["POST", "/api/p/beta/attachments"]],
  );
  await eventually(async () => (await drawer().getByPlaceholder("Describe this bead…").inputValue()).includes("attachment://ab-1/shot.png"), "the image is in the draft");
  const [edit] = await expectWrites("title and description", () => drawer().getByRole("button", { name: "Save", exact: true }).click(), [
    ["PATCH", "/api/p/beta/beads/ab-1", { title: "Beta one renamed" }],
  ]);
  assert.match(edit.json.description, /- \[ \] second step/, "the description is sent");
  await drawer().getByRole("heading", { name: "Beta one renamed", exact: true }).waitFor();
  await card("beta:ab-1").getByText("Beta one renamed").waitFor();
  assert.equal(await card("alpha:ab-1").getByText("Alpha one", { exact: true }).count(), 1, "the twin in alpha keeps its title");

  const [tick] = await expectWrites("checklist tick", () => drawer().locator('input[type="checkbox"]').first().click(), [
    ["PATCH", "/api/p/beta/beads/ab-1"],
  ]);
  assert.match(tick.json.description, /- \[x\] first step/, "the tick is sent as the toggled description");
  await eventually(() => drawer().locator('input[type="checkbox"]').first().isChecked(), "the panel shows the ticked task");

  await expectWrites("ask the AI", () => drawer().getByRole("button", { name: "Refine with AI" }).click(), [
    ["POST", "/api/p/beta/beads/ab-1/assist"],
  ]);
  await expectWrites("apply the AI suggestion", () => drawer().getByRole("button", { name: "Apply description" }).click(), [
    ["PATCH", "/api/p/beta/beads/ab-1", { description: "Refined by the assistant\n\n- [ ] refined step" }],
  ]);
  await eventually(async () => (await drawer().getByText("Refined by the assistant").count()) > 0 && (await drawer().getByText("AI suggestion").count()) === 0, "the panel shows the applied description");

  await drawer().getByPlaceholder(/^Comment as/).fill("Looks right");
  await expectWrites("comment", () => drawer().getByRole("button", { name: "Comment", exact: true }).click(), [
    ["POST", "/api/p/beta/beads/ab-1/comments", { text: "Looks right" }],
  ]);
  await drawer().getByText("Looks right", { exact: true }).waitFor();

  await drawer().getByLabel("Add label", { exact: true }).fill("urgent");
  await expectWrites("label on a bd project", () => drawer().getByLabel("Add label", { exact: true }).press("Enter"), [
    ["PATCH", "/api/p/beta/beads/ab-1", { labels: ["keep", "urgent"] }],
  ]);
  await drawer().getByRole("button", { name: "Remove label urgent", exact: true }).waitFor();

  await expectWrites("remove the dependency on ab-2", () => depRemove("ab-2").click(), [
    ["DELETE", "/api/p/beta/beads/ab-1/deps", { depends_on_id: "ab-2" }],
  ]);
  await depRow("ab-2").waitFor({ state: "detached" });

  await drawer().getByRole("button", { name: "Add dependency" }).click();
  const picked = await drawer().locator("[cmdk-item]").allInnerTexts();
  assert.ok(picked.some((t) => t.includes("Beta two")), `the picker lists beta's beads: ${picked}`);
  assert.ok(!picked.some((t) => t.includes("Alpha")), `the picker lists no bead of alpha: ${picked}`);
  await drawer().locator("[cmdk-item]", { hasText: "Beta two" }).click();
  await expectWrites("add the dependency on ab-2", () => drawer().getByRole("button", { name: "Add", exact: true }).click(), [
    ["POST", "/api/p/beta/beads/ab-1/deps", { depends_on_id: "ab-2", type: "blocks" }],
  ]);
  await depRow("ab-2").waitFor();

  await expectWrites("remove the incoming dependency of ab-4", () => depRemove("ab-4").click(), [
    ["DELETE", "/api/p/beta/beads/ab-4/deps", { depends_on_id: "ab-1" }],
  ]);
  await depRow("ab-4").waitFor({ state: "detached" });

  await expectWrites("detach the subtask", () => drawer().getByRole("button", { name: "Detach ab-3", exact: true }).click(), [
    ["PATCH", "/api/p/beta/beads/ab-3", { parent: "" }],
  ]);
  await drawer().getByRole("button", { name: "Detach ab-3", exact: true }).waitFor({ state: "detached" });

  // Add subtask: the dialog names beta, offers beta's beads only, and creates under the own id.
  step = "add subtask";
  await drawer().getByRole("button", { name: "Add subtask" }).click();
  await createDialog().waitFor();
  assert.match(await createDialog().getByRole("heading").innerText(), /in Beta Tools$/, "the dialog names the project");
  assert.equal(await createDialog().getByPlaceholder("No parent — type to search…").inputValue(), "ab-1 · Beta one renamed", "the parent is beta's ab-1");
  const parents = await createDialog().locator("datalist option").evaluateAll((options) => options.map((o) => o.value));
  assert.ok(parents.some((v) => v.includes("Beta two")), `the parent choices are beta's: ${parents}`);
  assert.ok(!parents.some((v) => v.includes("Alpha")), `the parent choices hold no bead of alpha: ${parents}`);
  await createDialog().getByPlaceholder("What needs doing?").fill("Beta child");
  await page.evaluate(() => window.__scottyProbe.order.splice(0));
  await expectWrites("create the subtask", () => createDialog().getByRole("button", { name: "Create bead" }).click(), [
    ["POST", "/api/p/beta/beads", { title: "Beta child", parent: "ab-1" }],
  ]);
  await createDialog().waitFor({ state: "detached" });
  await drawer().getByRole("button", { name: "Detach ab-6", exact: true }).waitFor();
  {
    // Probe: the dialog's own callback, which closes it, runs only once the bead is in the list.
    const order = await page.evaluate(() => window.__scottyProbe.order.slice());
    assert.ok(order.indexOf("list put") !== -1 && order.indexOf("list put") < order.indexOf("mutation success"), `probe: the answer is in the list before the caller's callback (${order})`);
  }

  await drawer().getByRole("button", { name: "Require approval" }).click();
  await drawer().getByPlaceholder(/^Reason \(optional\)/).fill("Needs sign-off");
  await expectWrites("require approval", () => drawer().getByRole("button", { name: "Create gate" }).click(), [
    ["POST", "/api/p/beta/beads/ab-1/gate", { reason: "Needs sign-off" }],
  ]);
  await card("beta:ab-5").waitFor();

  // Status changes to one bead go out one at a time, and the panel ends on what the tracker holds.
  assert.equal(await twoQuickChanges("both accepted", ["deferred", "open"], ["accept", "accept"], "open", "Blocked"), false, "both accepted: no fresh read is needed");
  await twoQuickChanges("A refused, B accepted", ["in_progress", "deferred"], ["refuse", "accept"], "deferred", "Backlog");
  await twoQuickChanges("A accepted, B refused", ["open", "in_progress"], ["accept", "refuse"], "open", "Blocked");
  assert.equal(
    await twoQuickChanges("both refused", ["deferred", "in_progress"], ["refuse", "refuse"], "open", "Blocked"),
    true,
    "both refused: a new read of the merged list is sent",
  );
  assert.equal(state.listAnswered, 1, "every change so far showed while the reads of the merged list stayed held");

  // A read of every project that started before a write must not land after it with old values.
  {
    step = "older read";
    const fetched = state.listFetches;
    state.pendingChange = true;
    await eventually(() => state.listFetches > fetched, "the stream started a new read of the merged list");
    await expectWrites("priority with an older read held", () => prioritySelect().selectOption("3"), [
      ["PATCH", "/api/p/beta/beads/ab-1", { priority: 3 }],
    ]);
    await eventually(async () => (await prioritySelect().inputValue()) === "3", "the panel shows the new priority");
    const answered = state.listAnswered;
    releaseLists();
    await eventually(() => state.listAnswered > answered, "the held read was answered");
    await page.waitForTimeout(400);
    assert.equal(await prioritySelect().inputValue(), "3", "the older read did not bring the old priority back");
  }

  // The same while a status write is still on its way: the read started first, the new status
  // was shown before any answer, and the read's old answer arrives before the write's.
  {
    step = "older read during a status write";
    const fetched = state.listFetches;
    state.pendingChange = true;
    await eventually(() => state.listFetches > fetched, "the stream started another read of the merged list");
    state.holdWrites = (w) => w.action === "status";
    await statusSelect().selectOption("in_progress");
    await eventually(() => state.heldWrites.length === 1, "the status change was sent");
    await eventually(async () => (await columnOf("beta:ab-1")) === "In Progress", "the card moved before the answer");
    const answered = state.listAnswered;
    releaseLists();
    await eventually(() => state.listAnswered > answered, "the older read was answered");
    await page.waitForTimeout(400);
    assert.equal(await statusSelect().inputValue(), "in_progress", "the older read did not put the old status back in the panel");
    assert.equal(await columnOf("beta:ab-1"), "In Progress", "the older read did not send the card back");
    release("accept");
    await claim("status with an older read held", [["POST", "/api/p/beta/beads/ab-1/status", { status: "in_progress" }]]);
    state.holdWrites = null;
  }

  // Going from one project's bead to another's while writes are still on their way: each write
  // reaches, and is answered into, the project it was asked for. The address is how the panel
  // gets from one bead to another without closing, as the browser's Back does.
  {
    step = "another project's bead with writes on their way";
    const titleOf = (projectId) => state.beads[projectId].find((b) => b.id === "ab-1").title;
    const showBead = async (projectId) => {
      await page.evaluate((id) => {
        const url = new URL(window.location.href);
        url.searchParams.set("bead", id);
        window.history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, `${projectId}:ab-1`);
      await drawer().getByRole("heading", { name: titleOf(projectId), exact: true }).waitFor();
    };
    const alphaStatus = state.beads.alpha.find((b) => b.id === "ab-1").status;

    state.holdWrites = (w) => w.action === "status";
    await statusSelect().selectOption("deferred");
    await eventually(() => state.heldWrites.length === 1, "the first of two status changes was sent");
    await statusSelect().selectOption("open");
    await showBead("alpha");
    release("accept");
    await eventually(() => state.heldWrites.length === 1, "the second status change went out");
    release("accept");
    await claim("two status changes asked for in beta's panel", [
      ["POST", "/api/p/beta/beads/ab-1/status", { status: "deferred" }],
      ["POST", "/api/p/beta/beads/ab-1/status", { status: "open" }],
    ]);
    await eventually(async () => (await columnOf("beta:ab-1")) === "Blocked", "beta's card ended on the second change");
    assert.equal(await statusSelect().inputValue(), alphaStatus, "alpha's bead kept its status");

    state.holdWrites = (w) => w.action === "comments";
    await drawer().getByPlaceholder(/^Comment as/).fill("Seen from alpha");
    await drawer().getByRole("button", { name: "Comment", exact: true }).click();
    await eventually(() => state.heldWrites.length === 1, "alpha's comment was sent");
    await showBead("beta");
    release("accept");
    await claim("a comment asked for in alpha's panel", [
      ["POST", "/api/p/alpha/beads/ab-1/comments", { text: "Seen from alpha" }],
    ]);
    state.holdWrites = null;
    await page.waitForTimeout(400);
    assert.equal(
      await drawer().getByRole("heading", { name: titleOf("beta"), exact: true }).count(),
      1,
      "alpha's answer did not replace beta's bead of the same id",
    );
    assert.equal(await drawer().getByText("Seen from alpha", { exact: true }).count(), 0, "alpha's comment is not on beta's bead");
    assert.equal(await prioritySelect().inputValue(), "3", "beta's bead kept its priority");
  }

  // Read-only mode, arriving while the subtask dialog holds text: the dialog goes, and the panel
  // keeps only what reads.
  step = "read-only";
  for (const title of ["Edit title & description", "Archive (close + label)", "Delete"]) {
    assert.equal(await drawer().getByTitle(title, { exact: true }).count(), 1, `editing mode: ${title} is offered`);
  }
  assert.equal(await drawer().getByRole("button", { name: "Require approval" }).count(), 1, "editing mode: Require approval is offered");
  await drawer().getByRole("button", { name: "Add subtask" }).click();
  await createDialog().getByPlaceholder("What needs doing?").fill("Half written");
  const writesBeforeReadOnly = state.writes.length;
  await setMode(true);
  await createDialog().waitFor({ state: "detached" });
  await banner().waitFor();
  assert.equal(await statusSelect().isDisabled(), true, "read-only: the status select is disabled");
  assert.equal(await prioritySelect().isDisabled(), true, "read-only: the priority select is disabled");
  assert.equal(await drawer().getByPlaceholder(/^Comment as/).isDisabled(), true, "read-only: the comment box is disabled");
  assert.equal(await drawer().getByLabel("Add label", { exact: true }).isDisabled(), true, "read-only: the label editor is disabled");
  assert.equal(await drawer().getByRole("button", { name: "Add dependency" }).isDisabled(), true, "read-only: Add dependency is disabled");
  assert.equal(await depRemove("ab-2").isDisabled(), true, "read-only: removing a dependency is disabled");
  for (const title of ["Edit title & description", "Archive (close + label)", "Delete"]) {
    assert.equal(await drawer().getByTitle(title, { exact: true }).count(), 0, `read-only: no ${title}`);
  }
  for (const name of ["Add subtask", "Require approval", "Refine with AI"]) {
    assert.equal(await drawer().getByRole("button", { name }).count(), 0, `read-only: no ${name}`);
  }
  await drawer().getByRole("button", { name: "Remove label urgent", exact: true }).click({ force: true });
  await drawer().locator('input[type="checkbox"]').first().click({ force: true });
  await drawer().getByTitle("Copy link").click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes("/p/"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/p/beta?bead=ab-1`, "read-only: Copy link works");
  await closePanel();
  await page.waitForTimeout(300);
  assert.equal(state.writes.length, writesBeforeReadOnly, "read-only: nothing but GET left the page");
  await setMode(false);
  await eventually(async () => (await banner().count()) === 0, "editing mode is back");
  await page.waitForTimeout(300);
  assert.equal(await createDialog().count(), 0, "the dialog does not come back with editing");
  assert.equal(state.writes.length, writesBeforeReadOnly, "the half-written subtask was never sent");

  // Closing with a reason, archive, then a delete whose answer arrives after the panel closed.
  step = "reopen beta's ab-1";
  await openPanel("beta:ab-1", "Beta one renamed");
  await statusSelect().selectOption("closed");
  await drawer().getByPlaceholder(/^Why is this done/).fill("Shipped");
  await expectWrites("close with a reason", () => drawer().getByRole("button", { name: "Close with reason" }).click(), [
    ["POST", "/api/p/beta/beads/ab-1/status", { status: "closed", reason: "Shipped" }],
  ]);
  await eventually(
    async () => (await statusSelect().inputValue()) === "closed" && (await columnOf("beta:ab-1")) === "Done",
    "the panel shows the closed status and the card is in Done",
  );
  await drawer().getByText("Shipped", { exact: true }).waitFor();

  await expectWrites("archive", () => drawer().getByTitle("Archive (close + label)").click(), [["POST", "/api/p/beta/beads/ab-1/archive"]]);
  await drawer().getByText("archived", { exact: true }).waitFor();

  state.holdWrites = (w) => w.method === "DELETE" && !w.action;
  page.once("dialog", (dialog) => dialog.accept());
  await drawer().getByTitle("Delete", { exact: true }).click();
  await claim("delete", [["DELETE", "/api/p/beta/beads/ab-1"]]);
  await drawer().waitFor({ state: "detached" });
  assert.equal(await card("beta:ab-1").count(), 1, "the card is still there while the delete is held");
  release("accept");
  await card("beta:ab-1").waitFor({ state: "detached" });
  assert.equal(await card("alpha:ab-1").count(), 1, "the twin in alpha is still on the board");
  state.holdWrites = null;

  // Approving a gate goes to the gate's own id; its effect arrives with the stream, not asserted.
  step = "open the gate";
  await openPanel("beta:ab-5", "Approval for ab-1");
  await expectWrites("approve the gate", () => drawer().getByRole("button", { name: "Approve", exact: true }).click(), [
    ["POST", "/api/p/beta/beads/ab-5/status", { status: "closed" }],
  ]);
  await closePanel();

  // Alpha tracks with br: a label is one increment to alpha, and beta's changes never reached it.
  step = "alpha's panel";
  await openPanel("alpha:ab-1", "Alpha one");
  assert.equal(await statusSelect().inputValue(), "open", "alpha's ab-1 kept its status");
  assert.equal(await prioritySelect().inputValue(), "2", "alpha's ab-1 kept its priority");
  await drawer().getByLabel("Add label", { exact: true }).fill("urgent");
  await expectWrites("label on a br project", () => drawer().getByLabel("Add label", { exact: true }).press("Enter"), [
    ["POST", "/api/p/alpha/beads/ab-1/labels", { add: ["urgent"], remove: [] }],
  ]);
  await drawer().getByRole("button", { name: "Remove label urgent", exact: true }).waitFor();
  await closePanel();

  assert.equal(state.writes.length, state.claimed, "every write was claimed by a step");
  assert.deepEqual(state.unexpected, [], "no unexpected request on the merged page");
  releaseLists();
  await page.context().close();

  // Two projects named alike: the dialog adds the project's id to the name.
  step = "two projects named alike";
  await openScenario({ projects: [alpha, beta, { id: "gamma", name: "Beta Tools", kind: "br" }] });
  await card("beta:ab-1").waitFor();
  await modeArrived();
  await openPanel("beta:ab-1", "Beta one");
  await drawer().getByRole("button", { name: "Add subtask" }).click();
  assert.match(await createDialog().getByRole("heading").innerText(), /in Beta Tools \(beta\)$/, "a shared name carries the id");
  await createDialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await createDialog().waitFor({ state: "detached" });
  assert.equal(state.writes.length, 0, "cancelling sends nothing");
  assert.deepEqual(state.unexpected, []);
  await page.context().close();

  // Until the viewer mode has answered, the panel is read-only: a slow answer must not leave it
  // editable in the meantime.
  step = "before the viewer mode answers";
  await openScenario({ holdMode: true });
  await card("beta:ab-1").waitFor();
  await openPanel("beta:ab-1", "Beta one");
  await page.waitForTimeout(300);
  assert.equal(await statusSelect().isDisabled(), true, "the status select is disabled until the mode is known");
  assert.equal(await drawer().getByRole("button", { name: "Add subtask" }).count(), 0, "Add subtask is absent until the mode is known");
  state.releaseMode();
  await eventually(async () => !(await statusSelect().isDisabled()), "the panel is editable once the mode says so");
  assert.equal(state.writes.length, 0, "nothing was sent while the mode was unknown");
  assert.deepEqual(state.unexpected, []);
  await page.context().close();

  const named = allRequests.filter((r) => {
    let decoded = r.path;
    try {
      decoded = decodeURIComponent(r.path);
    } catch {
      // Malformed percent-encoding is still checked as it is.
    }
    return FORBIDDEN.test(r.path) || FORBIDDEN.test(decoded) || FORBIDDEN.test(r.body);
  });
  assert.deepEqual(named, [], "no request path or body names @all or a namespaced id");

  console.log(
    `PASS: the all-projects panel writes to the bead's own project and id, shows each answer at once, ` +
      `orders status changes per bead and is inert in read-only mode (${allRequests.length} requests checked)`,
  );
} catch (error) {
  console.error(`Error at step "${step}": ${String(error?.message).split("\n")[0]}`);
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), writes: state?.writes.map((w) => `${w.method} ${w.path}`), unexpected: state?.unexpected, body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
