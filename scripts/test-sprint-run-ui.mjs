// Start and close on the page of one sprint, and the summary of a closed one. Every /api/
// response comes from fixtures through page.route, so no tracker is read or written. The
// fixtures record each request and change the sprint they answer with after a start or a close,
// which is how "the page reads as active afterwards" is observed. Set RUN_UI_SHOT_DIR to a
// directory to also save two screenshots: the close confirmation and a closed sprint's summary.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const T = "2026-09-01T00:00:00Z";
const ID = "2026-11-23";
const LABEL = `sprint:${ID}`;
const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };

function sprint(state = "planned", extra = {}) {
  return {
    id: ID, name: `Sprint ${ID}`, start: ID, end: "2026-11-28", capacity: 8, state,
    createdAt: T, startedAt: null, closedAt: null, planned: null,
    unreadableAtStart: [], summary: null, pending: [], ...extra,
  };
}

function bead(project, local, labels = [], o = {}) {
  return {
    id: `${project.id}:${local}`, local_id: local, project, title: o.title ?? `Title of ${local}`, description: "",
    status: o.status ?? "open", priority: 2, issue_type: "task", labels, comments: [],
    dependencies: [], created_at: T, updated_at: T,
  };
}

const ref = (project, id, title, size, points) => ({
  projectId: project.id, projectName: project.name, id, title, size, points,
});

const browser = await chromium.launch();
let page;

// `onStart` and `onClose` answer the two actions; each gets the fixture state and may change
// `state.sprint`, the way the server would.
async function openScenario({ sprintRecord = sprint(), beads = [], failed = [], readOnly = false, onStart, onClose } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const state = { sprint: sprintRecord, requests: [], bodies: [], viewerAnswers: 0, beadGets: 0 };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== "GET") {
      state.requests.push(`${method} ${path}`);
      state.bodies.push(request.postData());
    }
    if (path === "/api/all/beads/stream") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "retry: 600000\n: connected\n\n",
      });
    }
    if (path === "/api/viewer-mode") {
      state.viewerAnswers += 1;
      return route.fulfill({ json: { readOnly } });
    }
    if (path === "/api/sprints") return route.fulfill({ json: { sprints: [state.sprint] } });
    if (path === "/api/all/beads") {
      state.beadGets += 1;
      return route.fulfill({
        json: {
          beads,
          meta: {
            kind: "all", readOnly: true, humanActor: "reviewer", humanAllowlist: [], pollIntervalMs: 300_000,
            projects: [{ ...alpha, kind: "br", count: 1 }, { ...beta, kind: "br", count: 1 }], failed,
          },
        },
      });
    }
    if (path === `/api/sprints/${ID}/start` && method === "POST") return onStart(route, state);
    if (path === `/api/sprints/${ID}/close` && method === "POST") return onClose(route, state);
    if (path === "/api/capabilities") {
      return route.fulfill({ json: { workDashboardUrl: null, chain: false, notes: false, obsidianVault: null } });
    }
    state.requests.push(`UNROUTED ${method} ${path}`);
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/sprints/${ID}`);
  return { context, state };
}

// Scoped to the page body: the confirmation dialog lives in a portal and has buttons of its own.
const button = (name) => page.getByRole("main").getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog");
const badge = () => page.locator("span.rounded-full").first();
const members = () => page.getByTestId("members");
// The viewer mode has to have arrived and been rendered, or the page is read-only anyway.
async function modeArrived(s) {
  while (s.state.viewerAnswers === 0) await page.waitForTimeout(50);
  await page.waitForTimeout(300);
}
const posts = (s) => s.state.requests.filter((r) => r.startsWith("POST"));

try {
  let s;

  // Start: the confirmation states beads and points and names a project that failed to read;
  // confirming sends one start, no body, and the page then reads as active.
  s = await openScenario({
    beads: [bead(alpha, "a-1", [LABEL, "size:M"]), bead(beta, "b-1", [LABEL, "size:L"])],
    failed: [{ ...beta, id: "gamma", name: "Gamma Broken", error: "tracker unreadable" }],
    onStart: async (route, state) => {
      state.sprint = sprint("active", { startedAt: T });
      return route.fulfill({ json: state.sprint });
    },
    onClose: async (route) => route.fulfill({ status: 500, json: { error: "close was called" } }),
  });
  await members().waitFor();
  await modeArrived(s);
  assert.equal(await button("Close sprint").count(), 0, "a planned sprint offers no Close");
  await button("Start sprint").click();
  const text = await dialog().innerText();
  assert.match(text, /2 beads/, "start confirmation: the number of beads");
  assert.match(text, /5 points/, "start confirmation: the points");
  assert.match(text, /Gamma Broken/, "start confirmation names the project that could not be read");
  await dialog().getByRole("button", { name: "Start", exact: true }).click();
  await button("Close sprint").waitFor();
  assert.equal((await badge().innerText()).trim(), "active", "after a start the page reads as active");
  assert.equal(await button("Start sprint").count(), 0, "an active sprint offers no Start");
  for (let i = 0; i < 50 && s.state.beadGets < 2; i++) await page.waitForTimeout(100);
  assert.ok(s.state.beadGets >= 2, "a start refetches the beads of every project");
  assert.deepEqual(s.state.requests, [`POST /api/sprints/${ID}/start`], "one start and no close");
  assert.equal(s.state.bodies[0], null, "start sends no body");
  await s.context.close();

  // A sprint with no member cannot be started.
  s = await openScenario({});
  await members().waitFor();
  await modeArrived(s);
  assert.equal(await button("Start sprint").isDisabled(), true, "Start is disabled without a member");
  await s.context.close();

  // Start refused: the server's words are shown and the sprint still reads as planned.
  s = await openScenario({
    beads: [bead(alpha, "a-1", [LABEL, "size:M"])],
    onStart: async (route) =>
      route.fulfill({ status: 409, json: { error: "Sprint 2026-11-16 is already running", code: "another_sprint_running" } }),
  });
  await members().waitFor();
  await modeArrived(s);
  await button("Start sprint").click();
  await dialog().getByRole("button", { name: "Start", exact: true }).click();
  await page.getByText("Sprint 2026-11-16 is already running").waitFor();
  assert.equal((await badge().innerText()).trim(), "planned", "after a refusal the sprint still reads as planned");
  assert.equal(await button("Start sprint").isDisabled(), false, "the user can try again");
  await s.context.close();

  // Close: the confirmation splits done from not finished, with points, and says backlog.
  const activeBeads = [
    bead(alpha, "a-done", [LABEL, "size:L"], { status: "closed" }),
    bead(alpha, "a-open1", [LABEL, "size:S"]),
    bead(beta, "b-open2", [LABEL, "size:M"]),
  ];
  const summary = {
    plannedCount: 3, plannedPoints: 6, done: [ref(alpha, "a-done", "Title of a-done", "L", 3)],
    spillover: [], added: [], removed: [], unreadable: [],
  };
  s = await openScenario({
    sprintRecord: sprint("active", { startedAt: T }),
    beads: activeBeads,
    onStart: async (route) => route.fulfill({ status: 500, json: { error: "start was called" } }),
    onClose: async (route, state) => {
      state.sprint = sprint("closed", { startedAt: T, closedAt: T, summary, planned: [] });
      return route.fulfill({ json: state.sprint });
    },
  });
  await members().waitFor();
  await modeArrived(s);
  assert.equal(await button("Start sprint").count(), 0, "an active sprint offers no Start");
  await button("Close sprint").click();
  const closeText = await dialog().innerText();
  assert.match(closeText, /1 done \(3 points\)/, "close confirmation: done with its points");
  assert.match(closeText, /2 not finished \(3 points\)/, "close confirmation: not finished with its points");
  assert.match(closeText, /backlog/, "close confirmation says the rest goes back to the backlog");
  await page.waitForTimeout(400); // the dialog's opening animation, so a screenshot is sharp
  if (process.env.RUN_UI_SHOT_DIR) await page.screenshot({ path: `${process.env.RUN_UI_SHOT_DIR}/bmus-2gd.6-close.png` });
  await dialog().getByRole("button", { name: "Close sprint", exact: true }).click();
  await page.getByTestId("sprint-summary").waitFor();
  assert.equal((await badge().innerText()).trim(), "closed", "after a close the page reads as closed");
  assert.deepEqual(s.state.requests, [`POST /api/sprints/${ID}/close`], "one close and no start");
  assert.equal(s.state.bodies[0], null, "close sends no body");
  await s.context.close();

  // A close that stopped halfway: the alert lists what is left, and retrying calls close again.
  const stuck = ref(beta, "b-stuck", "Stuck bead", "M", 2);
  let closeCalls = 0;
  s = await openScenario({
    sprintRecord: sprint("active", { startedAt: T }),
    beads: [bead(alpha, "a-1", [LABEL, "size:S"], { status: "closed" }), bead(beta, "b-stuck", [LABEL, "size:M"])],
    onClose: async (route, state) => {
      closeCalls += 1;
      if (closeCalls === 1) {
        state.sprint = sprint("closing", { startedAt: T, pending: [stuck], summary });
        return route.fulfill({
          status: 500,
          json: { error: "Sprint is not closed: 1 bead(s) still carry its label", code: "close_incomplete", remaining: [stuck], sprint: state.sprint },
        });
      }
      state.sprint = sprint("closed", { startedAt: T, closedAt: T, summary, planned: [] });
      return route.fulfill({ json: state.sprint });
    },
  });
  await members().waitFor();
  await modeArrived(s);
  await button("Close sprint").click();
  await dialog().getByRole("button", { name: "Close sprint", exact: true }).click();
  const alert = page.getByTestId("closing-alert");
  await alert.waitFor();
  assert.match(await alert.innerText(), /b-stuck/, "the alert lists the bead still pending");
  assert.match(await alert.innerText(), /Beta Tools/, "the alert names its project");
  assert.equal(await page.getByText("1 bead(s) still carry its label").count() > 0, true, "the server's message is shown too");
  await button("Try again").click();
  await page.getByTestId("sprint-summary").waitFor();
  assert.deepEqual(posts(s), [`POST /api/sprints/${ID}/close`, `POST /api/sprints/${ID}/close`], "retry calls close again");
  await s.context.close();

  // A closed sprint: six figures, each list's beads, an unreadable project, and no control.
  const closedSummary = {
    plannedCount: 4, plannedPoints: 8,
    done: [ref(alpha, "d-1", "Done one", "M", 2), ref(beta, "d-2", "Done two", "L", 3)],
    spillover: [ref(alpha, "s-1", "Spilled one", "S", 1), ref(beta, "s-2", "Spilled two", null, 0), ref(alpha, "s-3", "Spilled three", "L", 3)],
    added: [ref(alpha, "n-1", "Added one", "XL", 5)],
    removed: [ref(beta, "r-1", "Removed one", "M", 2), ref(alpha, "r-2", "Removed two", "S", 1)],
    unreadable: ["Gamma Broken"],
  };
  const planned = [ref(alpha, "d-1", "Done one", "M", 2), ref(beta, "d-2", "Done two", "L", 3), ref(alpha, "s-1", "Spilled one", "S", 1), ref(beta, "r-1", "Removed one", "M", 2)];
  s = await openScenario({
    sprintRecord: sprint("closed", { startedAt: T, closedAt: T, summary: closedSummary, planned }),
    beads: [bead(alpha, "d-1")],
  });
  await page.getByTestId("sprint-summary").waitFor();
  await modeArrived(s);
  const figures = async (id) => (await page.getByTestId(`summary-${id}`).getByTestId("summary-figures").innerText()).trim();
  assert.equal(await figures("planned"), "4 beads · 8 points", "planned count and points");
  assert.equal(await figures("done"), "2 beads · 5 points", "done count and points");
  assert.equal(await figures("spillover"), "3 beads · 4 points", "spilled over count and points");
  assert.equal(await figures("added"), "1 bead · 5 points", "added count and points");
  assert.equal(await figures("removed"), "2 beads · 3 points", "removed count and points");
  const listed = (id) => page.getByTestId(`summary-${id}`).getByTestId("summary-bead").evaluateAll((els) => els.map((e) => e.getAttribute("data-bead-id")));
  assert.deepEqual(await listed("planned"), ["alpha:d-1", "beta:d-2", "alpha:s-1", "beta:r-1"]);
  assert.deepEqual(await listed("done"), ["alpha:d-1", "beta:d-2"]);
  assert.deepEqual(await listed("spillover"), ["alpha:s-1", "beta:s-2", "alpha:s-3"]);
  assert.deepEqual(await listed("added"), ["alpha:n-1"]);
  assert.deepEqual(await listed("removed"), ["beta:r-1", "alpha:r-2"]);
  const rowText = await page.getByTestId("summary-done").innerText();
  assert.match(rowText, /Done two/, "a listed bead shows its title");
  assert.match(rowText, /Beta Tools/, "a listed bead shows its project");
  assert.match(rowText, /\bL\b/, "a listed bead shows its size");
  assert.match(await page.getByTestId("summary-unreadable").innerText(), /Gamma Broken/, "an unreadable project is named");
  assert.equal(await page.getByRole("main").getByRole("button", { name: /^(Start|Close sprint|Move|Size)/ }).count(), 0, "a closed sprint has no control");
  if (process.env.RUN_UI_SHOT_DIR) await page.screenshot({ path: `${process.env.RUN_UI_SHOT_DIR}/bmus-2gd.6-summary.png`, fullPage: true });
  await s.context.close();

  // Read-only: neither control, and nothing but GET leaves the page.
  for (const state of ["planned", "active"]) {
    s = await openScenario({
      readOnly: true,
      sprintRecord: sprint(state, { startedAt: T }),
      beads: [bead(alpha, "a-1", [LABEL, "size:M"])],
    });
    await members().waitFor();
    await modeArrived(s);
    assert.equal(await page.getByRole("main").getByRole("button", { name: /^(Start|Close sprint)/ }).count(), 0, `read-only ${state}: no Start or Close`);
    assert.deepEqual(s.state.requests, [], `read-only ${state}: nothing but GET`);
    await s.context.close();
  }

  // Read-only, on a sprint whose close stopped halfway: the alert still says what is left, and
  // the retry, which writes to trackers, is not offered.
  s = await openScenario({
    readOnly: true,
    sprintRecord: sprint("closing", { startedAt: T, pending: [ref(beta, "b-9", "Stuck one", "M", 2)] }),
    beads: [bead(beta, "b-9", [LABEL, "size:M"])],
  });
  await page.getByTestId("closing-alert").waitFor();
  await modeArrived(s);
  assert.match(await page.getByTestId("closing-alert").innerText(), /b-9/, "read-only closing: the alert lists the bead still pending");
  assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "read-only closing: no retry");
  assert.deepEqual(s.state.requests, [], "read-only closing: nothing but GET");
  await s.context.close();

  console.log("sprint run UI: ok");
} finally {
  await browser.close();
}
