// The Sprints page at /sprints: list order, committed points, create, edit, delete, labels that
// match no sprint, failed projects and read-only mode. Every /api/ response comes from fixtures
// through page.route, so no tracker and no sprint file is read or written; the fixtures record
// each request, which is how the bodies of the writes and the absence of writes are asserted.
// Set SPRINTS_SHOT to a file path to also save a screenshot of the populated page.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };

function sprint(start, name, state, capacity = 20) {
  return {
    id: start, name, start, end: start.replace(/-\d\d$/, "-28"), capacity, state,
    createdAt: T, startedAt: null, closedAt: null, planned: null,
    unreadableAtStart: [], summary: null, pending: [],
  };
}

function bead(project, local, labels, status = "open") {
  return {
    id: `${project.id}:${local}`, local_id: local, project, title: `Bead ${local}`, description: "",
    status, priority: 2, issue_type: "task", labels, comments: [], dependencies: [],
    created_at: T, updated_at: T,
  };
}

const ordered = () => [
  sprint("2026-10-05", "Old one", "closed"),
  sprint("2026-11-30", "Plan B", "planned"),
  sprint("2026-11-16", "Running", "active"),
  sprint("2026-10-19", "Old two", "closed"),
  sprint("2026-11-23", "Plan A", "planned"),
];

const browser = await chromium.launch();
let page;

async function openScenario({ sprints = [], beads = [], failed = [], readOnly = false, refuse = null, beadsFail = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const state = { sprints: [...sprints], requests: [], unrouted: [] };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (path === "/api/all/beads/stream") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "retry: 600000\n: connected\n\n",
      });
    }
    if (path === "/api/viewer-mode") return route.fulfill({ json: { readOnly } });
    if (path === "/api/all/beads") {
      if (beadsFail) return route.fulfill({ status: 500, json: { error: "merged read broke" } });
      return route.fulfill({
        json: {
          beads,
          meta: {
            kind: "all", readOnly: true, humanActor: "reviewer", humanAllowlist: [],
            pollIntervalMs: 300_000, projects: [{ ...alpha, kind: "br", count: 1 }, { ...beta, kind: "br", count: 1 }], failed,
          },
        },
      });
    }
    if (path.startsWith("/api/sprints")) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      if (method !== "GET") state.requests.push({ method, path, body });
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      if (method === "GET") return route.fulfill({ json: { sprints: state.sprints } });
      if (readOnly) return route.fulfill({ status: 403, json: { error: "Read-only mode", code: "read_only" } });
      if (refuse) return route.fulfill({ status: refuse.status, json: refuse.body });
      if (method === "POST") {
        const created = sprint(body.start, body.name, "planned", body.capacity);
        created.end = body.end;
        state.sprints.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      const target = state.sprints.find((s) => s.id === id);
      if (method === "PATCH") {
        Object.assign(target, body);
        return route.fulfill({ json: target });
      }
      state.sprints = state.sprints.filter((s) => s.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/capabilities") {
      return route.fulfill({ json: { workDashboardUrl: null, chain: false, notes: false, obsidianVault: null } });
    }
    state.unrouted.push(path);
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/sprints`);
  return { context, state };
}

const rows = () => page.getByTestId("sprint-row");
const row = (name) => rows().filter({ hasText: name });
const dialog = () => page.getByRole("dialog");
const rowNames = async () =>
  (await rows().evaluateAll((els) => els.map((el) => el.querySelector("div.truncate")?.textContent)));

async function fillForm({ name, start, end, capacity }) {
  if (name !== undefined) await dialog().getByLabel("Name").fill(name);
  if (start !== undefined) await dialog().getByLabel("Start date").fill(start);
  if (end !== undefined) await dialog().getByLabel("End date").fill(end);
  if (capacity !== undefined) await dialog().getByLabel("Capacity").fill(String(capacity));
}

try {
  let s;

  // Order: running first, planned ascending, closed descending. Also the page's links and the shot.
  s = await openScenario({ sprints: ordered(), beads: [bead(alpha, "a-1", ["sprint:2026-11-23", "size:M"])] });
  await rows().first().waitFor();
  assert.deepEqual(await rowNames(), ["Running", "Plan A", "Plan B", "Old two", "Old one"], "row order");
  assert.equal(await page.getByRole("link", { name: "← Back to projects" }).getAttribute("href"), "/");
  assert.equal(await page.getByRole("link", { name: "All projects" }).getAttribute("href"), "/all");
  assert.match(await row("Plan A").innerText(), /2026-11-23 to 2026-11-28/, "the row shows its dates");
  assert.equal(await row("Plan A").getByRole("link", { name: "Plan A", exact: true }).getAttribute("href"), "/sprints/2026-11-23", "a sprint's name links to its own page");
  assert.equal(
    await row("Plan A").getByRole("link", { name: "Open Plan A on the board", exact: true }).getAttribute("href"),
    "/all?label=sprint%3A2026-11-23&done=all",
    "and its Board link opens the board of every project narrowed to it",
  );
  assert.equal(await page.getByRole("link", { name: /^Open .* on the board$/ }).count(), 5, "a Board link on every sprint, whatever its state");
  assert.equal(await page.getByTestId("orphan-labels").count(), 0, "every label matches: no orphan section");
  if (process.env.SPRINTS_SHOT) {
    await s.context.close();
    s = await openScenario({
      sprints: ordered(),
      beads: [
        bead(alpha, "a-1", ["sprint:2026-11-23", "size:M"]),
        bead(alpha, "a-2", ["sprint:2026-11-23", "size:L"], "closed"),
        bead(beta, "b-1", ["sprint:2026-11-23"]),
        bead(beta, "b-2", ["sprint:2026-11-16", "size:XL"]),
        bead(beta, "b-3", ["sprint:2026-01-05"]),
      ],
      failed: [{ ...beta, error: "tracker unreadable" }],
    });
    await rows().first().waitFor();
    await page.getByTestId("orphan-labels").waitFor();
    await page.screenshot({ path: process.env.SPRINTS_SHOT });
  }
  await s.context.close();

  // Committed points count every status; unsized beads count 0 and are named.
  s = await openScenario({
    sprints: [sprint("2026-11-23", "Plan A", "planned", 20)],
    beads: [
      bead(alpha, "a-1", ["sprint:2026-11-23", "size:M"]),
      bead(alpha, "a-2", ["sprint:2026-11-23", "size:L"], "closed"),
      bead(beta, "b-1", ["sprint:2026-11-23"]),
      bead(beta, "b-2", ["size:XL"]),
    ],
  });
  await row("Plan A").waitFor();
  const text = await row("Plan A").innerText();
  assert.match(text, /5 \/ 20 points/, "committed points");
  assert.match(text, /3 beads/, "bead count");
  assert.match(text, /1 unsized/, "unsized count");
  await s.context.close();

  // A fully sized sprint does not mention unsized beads.
  s = await openScenario({
    sprints: [sprint("2026-11-23", "Plan A", "planned")],
    beads: [bead(alpha, "a-1", ["sprint:2026-11-23", "size:S"])],
  });
  await row("Plan A").waitFor();
  assert.ok(!(await row("Plan A").innerText()).includes("unsized"), "no unsized note when every bead has a size");
  await s.context.close();

  // No sprint: the page says so, and creating works, with the exact body, no reload.
  s = await openScenario();
  await page.getByText("No sprints yet.").waitFor();
  await page.getByRole("button", { name: "Create a sprint" }).waitFor();
  await page.getByRole("button", { name: "New sprint" }).click();
  await fillForm({ name: "Alpha sprint", start: "2026-11-23", end: "2026-11-29", capacity: 20 });
  await dialog().getByRole("button", { name: "Create sprint" }).click();
  await row("Alpha sprint").waitFor();
  assert.deepEqual(s.state.requests, [
    { method: "POST", path: "/api/sprints", body: { name: "Alpha sprint", start: "2026-11-23", end: "2026-11-29", capacity: 20 } },
  ], "one POST with exactly four keys, the capacity a number");
  assert.equal(typeof s.state.requests[0].body.capacity, "number");
  await dialog().waitFor({ state: "hidden" });
  await s.context.close();

  // Validation: nothing is sent, and a message sits beside the field.
  s = await openScenario();
  await page.getByRole("button", { name: "New sprint" }).click();
  await fillForm({ name: "Bad", start: "2026-11-29", end: "2026-11-23", capacity: 20 });
  await dialog().getByRole("button", { name: "Create sprint" }).click();
  await dialog().getByText("The end date cannot be before the start date").waitFor();
  await fillForm({ end: "2026-11-30", name: "", capacity: 1.5 });
  await dialog().getByRole("button", { name: "Create sprint" }).click();
  await dialog().getByText("Give the sprint a name").waitFor();
  await dialog().getByText("Capacity is a whole number").waitFor();
  assert.equal(await dialog().getByText("The end date cannot be before the start date").count(), 0, "a fixed field loses its message");
  await page.waitForTimeout(300);
  assert.deepEqual(s.state.requests, [], "an invalid form sends nothing");
  await s.context.close();

  // The server refuses a duplicate: the form stays open with the server's words.
  s = await openScenario({
    sprints: [sprint("2026-11-23", "Plan A", "planned")],
    refuse: { status: 409, body: { error: "A sprint starting 2026-11-23 already exists", code: "sprint_exists" } },
  });
  await row("Plan A").waitFor();
  await page.getByRole("button", { name: "New sprint" }).click();
  await fillForm({ name: "Again", start: "2026-11-23", end: "2026-11-29", capacity: 5 });
  await dialog().getByRole("button", { name: "Create sprint" }).click();
  await dialog().getByText("A sprint starting 2026-11-23 already exists").waitFor();
  assert.equal(await dialog().count(), 1, "the form stays open");
  assert.equal(s.state.requests.length, 1, "the refused request was sent once");
  await s.context.close();

  // Editing: the start is fixed and only the changed keys travel.
  s = await openScenario({ sprints: [sprint("2026-11-23", "Plan A", "planned", 20)] });
  await row("Plan A").waitFor();
  await page.getByRole("button", { name: "Edit Plan A" }).click();
  assert.equal(await dialog().getByLabel("Start date").isDisabled(), true, "the start date cannot be edited");
  assert.equal(await dialog().getByLabel("Start date").inputValue(), "2026-11-23");
  await dialog().getByText("start date identifies the sprint").waitFor();
  await fillForm({ capacity: 25 });
  await dialog().getByRole("button", { name: "Save" }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.deepEqual(s.state.requests, [{ method: "PATCH", path: "/api/sprints/2026-11-23", body: { capacity: 25 } }]);
  await row("/ 25 points").waitFor();
  await page.getByRole("button", { name: "Edit Plan A" }).click();
  await fillForm({ name: "Plan A2", end: "2026-11-27" });
  await dialog().getByRole("button", { name: "Save" }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.deepEqual(s.state.requests[1], { method: "PATCH", path: "/api/sprints/2026-11-23", body: { name: "Plan A2", end: "2026-11-27" } });
  await page.getByRole("button", { name: "Edit Plan A2" }).click();
  await dialog().getByRole("button", { name: "Save" }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(s.state.requests.length, 2, "saving without a change sends nothing");
  await s.context.close();

  // Delete: planned only, behind a confirmation that counts the beads.
  s = await openScenario({
    sprints: ordered(),
    beads: [bead(alpha, "a-1", ["sprint:2026-11-30"]), bead(beta, "b-1", ["sprint:2026-11-30"])],
  });
  await rows().first().waitFor();
  assert.equal(await page.getByRole("button", { name: /^Delete / }).count(), 2, "delete only on the two planned sprints");
  for (const name of ["Running", "Old one", "Old two"]) {
    assert.equal(await page.getByRole("button", { name: `Delete ${name}` }).count(), 0, `no delete on ${name}`);
  }
  await page.getByRole("button", { name: "Delete Plan B" }).click();
  const confirmation = await dialog().innerText();
  assert.match(confirmation, /\b2 beads keep\b/, "the confirmation counts the beads that keep the label");
  assert.deepEqual(s.state.requests, [], "opening the confirmation sends nothing");
  await dialog().getByRole("button", { name: "Delete sprint" }).click();
  await row("Plan B").waitFor({ state: "detached" });
  assert.deepEqual(s.state.requests, [{ method: "DELETE", path: "/api/sprints/2026-11-30", body: undefined }]);
  await page.getByTestId("orphan-labels").waitFor();
  assert.match(await page.getByTestId("orphan-labels").innerText(), /sprint:2026-11-30 on 2 beads/, "the deleted sprint's label is now reported");
  await s.context.close();

  // Labels that match no sprint, and beads with more than one.
  s = await openScenario({
    sprints: [sprint("2026-11-23", "Plan A", "planned")],
    beads: [
      bead(alpha, "a-1", ["sprint:2026-01-05"]),
      bead(alpha, "a-2", ["sprint:2026-11-23", "sprint:2026-01-05"]),
      bead(beta, "b-1", ["sprint:2026-11-23"]),
    ],
  });
  const orphans = page.getByTestId("orphan-labels");
  await orphans.waitFor();
  const orphanText = await orphans.innerText();
  assert.match(orphanText, /sprint:2026-01-05 on 2 beads/, "the unmatched label with its count");
  assert.ok(!orphanText.includes("sprint:2026-11-23"), "a matched label is not listed");
  assert.match(orphanText, /1 bead carry more than one sprint label/, "beads with two sprint labels");
  await s.context.close();

  // A project that could not be read is named with its error.
  s = await openScenario({ sprints: [sprint("2026-11-23", "Plan A", "planned")], failed: [{ ...beta, error: "tracker unreadable" }] });
  const notice = page.getByRole("alert").filter({ hasText: "Beta Tools" });
  await notice.waitFor();
  assert.match(await notice.innerText(), /tracker unreadable/);
  await s.context.close();

  // A closed sprint cannot be edited, so it offers no Edit that the server would only refuse.
  s = await openScenario({ sprints: ordered() });
  await rows().first().waitFor();
  assert.equal(await page.getByRole("button", { name: /^Edit / }).count(), 3, "Edit on the running and the two planned sprints only");
  assert.equal(await page.getByRole("button", { name: "Edit Old one" }).count(), 0, "no Edit on a closed sprint");
  assert.equal(await page.getByRole("button", { name: /^Add beads to / }).count(), 3, "Add beads on the same three sprints");
  assert.equal(await page.getByRole("button", { name: "Add beads to Old one" }).count(), 0, "no Add beads on a closed sprint");
  await s.context.close();

  // The bead list could not be read: the page says so, and no sprint is shown as empty.
  s = await openScenario({ sprints: ordered(), beadsFail: true });
  await page.getByRole("alert").filter({ hasText: "Couldn’t read the beads" }).waitFor();
  await row("Plan A").getByText("Beads not counted").waitFor();
  assert.equal(await page.getByText(/\d+ beads?$/).count(), 0, "no row claims a number of beads");
  assert.match(await row("Plan A").innerText(), /… \/ 20 points/, "the committed points are not shown as a number");
  await s.context.close();

  // Read-only: every control is disabled and only GETs leave the page.
  s = await openScenario({ sprints: ordered(), readOnly: true });
  await rows().first().waitFor();
  await page.getByRole("button", { name: "New sprint" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "New sprint" }).isDisabled(), true);
  for (const name of ["Edit Running", "Edit Plan A", "Delete Plan A", "Delete Plan B", "Add beads to Running", "Add beads to Plan A"]) {
    assert.equal(await page.getByRole("button", { name }).isDisabled(), true, `${name} is disabled`);
  }
  await page.getByRole("button", { name: "Edit Plan A" }).click({ force: true });
  await page.getByRole("button", { name: "Delete Plan A" }).click({ force: true });
  await page.getByRole("button", { name: "New sprint" }).click({ force: true });
  await page.waitForTimeout(300);
  assert.deepEqual(s.state.requests, [], "no write left the page in read-only mode");
  await s.context.close();
  s = await openScenario({ readOnly: true });
  await page.getByText("No sprints yet.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create a sprint" }).isDisabled(), true, "the empty-state create is disabled too");
  await s.context.close();

  console.log("PASS: /sprints lists, creates, edits and deletes sprints, reports unmatched labels and failed projects, and follows read-only mode");
} catch (error) {
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
