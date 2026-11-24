// The Done window shared by the board and the list. Two halves: the pure rules load
// lib/done-window.ts without a build; the browser half runs only when SCOTTY_TEST_URL is set and
// answers every API response from fixtures, so no tracker is read or written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
function load(relative) {
  const url = new URL(relative, import.meta.url);
  if (cache.has(url.href)) return cache.get(url.href);
  const exports = {};
  cache.set(url.href, exports);
  const code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    URL,
    URLSearchParams,
    require: (name) => (name.startsWith(".") ? load(new URL(`${name}.ts`, url).href) : nodeRequire(name)),
  });
  return exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const { DONE_WINDOW_OPTIONS, readDoneWindow, doneWindowToWrite, isInDoneWindow } = load("../lib/done-window.ts");

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

// ---- pure half ----
{
  assert.deepEqual(
    plain(DONE_WINDOW_OPTIONS),
    [
      { value: "none", label: "Hidden" },
      { value: 7, label: "Last 7 days" },
      { value: 28, label: "Last 4 weeks" },
      { value: 90, label: "Last 3 months" },
      { value: 365, label: "Last 12 months" },
      { value: "all", label: "All time" },
    ],
    "the options come in this order with these labels",
  );

  const wanted = [["none", "none"], ["7", 7], ["28", 28], ["90", 90], ["365", 365], ["all", "all"]];
  for (const fallback of ["none", "all"]) {
    for (const [raw, value] of wanted) assert.equal(readDoneWindow(raw, fallback), value, `"${raw}" reads as itself under ${fallback}`);
    for (const raw of [null, "", "nonsense", "8", "7.0", "-7", "ALL", "7 "]) {
      assert.equal(readDoneWindow(raw, fallback), fallback, `${JSON.stringify(raw)} reads as the page's default ${fallback}`);
    }
  }

  for (const fallback of ["none", "all"]) {
    assert.equal(doneWindowToWrite(fallback, fallback), null, `choosing the default (${fallback}) writes no parameter`);
    for (const [raw, value] of wanted) {
      if (value !== fallback) assert.equal(doneWindowToWrite(value, fallback), raw, `choosing ${raw} under ${fallback} writes it`);
    }
  }

  const closed = (extra) => ({ status: "closed", ...extra });
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(2) }), 7, NOW), true, "closed 2 days ago is inside 7 days");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(8) }), 7, NOW), false, "closed 8 days ago is outside 7 days");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(7) }), 7, NOW), true, "closed exactly 7 days ago is inside");
  assert.equal(isInDoneWindow(closed({ closed_at: new Date(NOW - 7 * DAY - 1).toISOString() }), 7, NOW), false, "one millisecond older is outside");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(10) }), 28, NOW), true, "the 4 week window reaches 10 days back");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(100) }), 90, NOW), false, "the 3 month window stops before 100 days");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(300) }), 365, NOW), true, "the 12 month window reaches 300 days back");
  assert.equal(isInDoneWindow(closed({ updated_at: daysAgo(2) }), 7, NOW), true, "no closed_at: updated_at is judged");
  assert.equal(isInDoneWindow(closed({ updated_at: daysAgo(8) }), 7, NOW), false, "no closed_at: an old updated_at is outside");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(60), updated_at: daysAgo(1) }), 7, NOW), false, "closed_at wins over a recent edit");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(1), updated_at: daysAgo(60) }), 7, NOW), true, "closed_at wins over an old edit");
  assert.equal(isInDoneWindow(closed({ closed_at: null }), 7, NOW), false, "a closed bead with neither date is outside");
  assert.equal(isInDoneWindow(closed({}), 7, NOW), false, "a closed bead with no dates at all is outside");
  assert.equal(isInDoneWindow(closed({ closed_at: "not a date" }), 7, NOW), false, "an unreadable date is outside");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(2) }), "none", NOW), false, "hidden keeps no closed bead");
  assert.equal(isInDoneWindow(closed({}), "none", NOW), false, "hidden keeps a dateless closed bead out");
  assert.equal(isInDoneWindow(closed({ closed_at: daysAgo(900) }), "all", NOW), true, "all time keeps every closed bead");
  assert.equal(isInDoneWindow(closed({}), "all", NOW), true, "all time keeps even a dateless closed bead");
  for (const status of ["open", "in_progress", "deferred", "blocked"]) {
    for (const window of ["none", 7, "all"]) {
      assert.equal(isInDoneWindow({ status, updated_at: daysAgo(900) }, window, NOW), true, `a ${status} bead is never excluded (${window})`);
    }
  }
  console.log("PASS (pure): parameter reading, the value written, inclusion at a fixed instant");
}

const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log("SKIP (browser): SCOTTY_TEST_URL is not set");
  process.exit(0);
}
const { chromium } = await import("playwright");

const nowIso = (days) => new Date(Date.now() - days * DAY).toISOString();
const task = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status: "open",
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: nowIso(200),
  updated_at: nowIso(200),
  ...extra,
});
const closedTask = (id, closedDaysAgo, extra = {}) =>
  task(id, { status: "closed", closed_at: nowIso(closedDaysAgo), updated_at: nowIso(closedDaysAgo), ...extra });

const browser = await chromium.launch();
let page;
const selector = () => page.getByRole("combobox", { name: "Done window" });
const params = () => new URL(page.url()).searchParams;
const cardIds = async () =>
  (await page.locator("[data-keyboard-bead-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-keyboard-bead-id")))).sort();
// A wrong card count is reported as the cards that were on screen, not as a timeout.
const settled = async (expected) => {
  await page
    .waitForFunction((n) => document.querySelectorAll("[data-keyboard-bead-id]").length === n, expected.length, { timeout: 4000 })
    .catch(() => {});
  assert.deepEqual(await cardIds(), [...expected].sort(), `cards on screen at ${page.url()}`);
};

const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };
// A merged-list bead the way lib/aggregate.ts namespaces it.
function merged(project, local, fields = {}) {
  const id = `${project.id}:${local}`;
  const dependencies = (fields.deps ?? []).map(([to, type]) => ({ issue_id: id, depends_on_id: `${project.id}:${to}`, type }));
  const closedAt = fields.closedDaysAgo === undefined ? undefined : nowIso(fields.closedDaysAgo);
  return {
    id,
    local_id: local,
    project,
    title: `Task ${local}`,
    description: "",
    status: fields.closedDaysAgo === undefined ? "open" : "closed",
    priority: 2,
    issue_type: fields.type ?? "task",
    labels: [],
    comments: [],
    dependencies,
    created_at: nowIso(200),
    updated_at: fields.updatedDaysAgo === undefined ? (closedAt ?? nowIso(200)) : nowIso(fields.updatedDaysAgo),
    ...(closedAt ? { closed_at: closedAt } : {}),
    ...(fields.parent ? { parent: `${project.id}:${fields.parent}` } : {}),
  };
}

async function allProjectsPage(beads) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const writes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/all/beads/stream") return route.abort();
    if (request.method() !== "GET") {
      writes.push({ path, method: request.method() });
      return route.fulfill({ json: {} });
    }
    if (path === "/api/all/beads") {
      return route.fulfill({
        json: {
          beads,
          meta: {
            kind: "all",
            readOnly: true,
            humanActor: "reviewer",
            humanAllowlist: ["reviewer"],
            pollIntervalMs: 300_000,
            projects: [{ ...alpha, kind: "br", count: 9 }, { ...beta, kind: "bd", count: 1 }],
            failed: [],
          },
        },
      });
    }
    if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
    return route.fulfill({ json: {} });
  });
  return { context, writes };
}

const columnOf = (id) =>
  page.locator(`[data-keyboard-bead-id="${id}"]`).evaluate((el) => el.closest("section")?.querySelector("span.font-semibold")?.textContent);
const selected = () => selector().locator("option:checked").innerText();

async function singleProjectPage(beads) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const writes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (request.method() !== "GET") {
      writes.push({ path, method: request.method() });
      return route.fulfill({ json: {} });
    }
    if (path === "/api/p/demo/beads") {
      return route.fulfill({
        json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 } },
      });
    }
    return route.fulfill({ json: {} });
  });
  return { context, writes };
}

try {
  // ---- a single project's page: all time by default, the hidden choice added on the board ----
  const demoBeads = [
    task("open-1"),
    closedTask("recent", 2),
    closedTask("old", 60, { updated_at: nowIso(1) }),
  ];
  const everything = ["old", "open-1", "recent"];
  const single = await singleProjectPage(demoBeads);

  await page.goto(`${base}/p/demo?view=board`);
  await settled(everything);
  assert.equal(await selector().inputValue(), "", "board: no parameter reads as all time");
  assert.deepEqual(
    await selector().locator("option").allInnerTexts(),
    ["Hidden", "Last 7 days", "Last 4 weeks", "Last 3 months", "Last 12 months", "All time"],
    "board: the selector offers the six choices in order",
  );

  await page.goto(`${base}/p/demo?view=board&done=none`);
  await settled(["open-1"]);
  assert.equal(await selector().inputValue(), "none", "board: done=none reads as hidden");
  assert.equal(await page.locator("section", { hasText: "Done" }).count(), 1, "board: the Done column stays on screen with its cards hidden");
  assert.equal(await selector().locator("option:checked").innerText(), "Hidden", "board: the selector reads Hidden");

  await page.goto(`${base}/p/demo?view=board&done=nonsense`);
  await settled(everything);
  assert.equal(await selector().inputValue(), "", "board: an unrecognised value reads as all time");

  await page.goto(`${base}/p/demo?view=board&done=7`);
  await settled(["open-1", "recent"]);
  assert.equal(await selector().locator("option:checked").innerText(), "Last 7 days");

  await selector().selectOption("none");
  await settled(["open-1"]);
  assert.equal(params().get("done"), "none", "board: choosing Hidden writes done=none");
  await selector().selectOption("");
  await settled(everything);
  assert.equal(params().has("done"), false, "board: choosing All time (the default) removes the parameter");
  await selector().selectOption("28");
  await settled(["open-1", "recent"]);
  assert.equal(params().get("done"), "28");

  await page.goto(`${base}/p/demo?view=list&done=none`);
  await settled(everything);
  assert.equal(await selector().count(), 0, "list: a project's list has no Done selector");
  await page.goto(`${base}/p/demo?view=list&done=7`);
  await settled(everything);
  assert.equal(await selector().count(), 0, "list: still none with a window in the address");
  assert.equal(single.writes.length, 0, "the test sent no write");
  await single.context.close();

  // ---- the all-projects page: closed beads hidden by default, one window for board and list ----
  const allBeads = [
    merged(alpha, "open-1"),
    merged(alpha, "recent", { closedDaysAgo: 2 }),
    merged(alpha, "old", { closedDaysAgo: 60, updatedDaysAgo: 1 }),
    merged(alpha, "blocker", { closedDaysAgo: 60 }),
    merged(alpha, "waiting", { deps: [["blocker", "blocks"]] }),
    merged(alpha, "e-1", { type: "epic" }),
    merged(alpha, "kid-done", { closedDaysAgo: 60, parent: "e-1", deps: [["e-1", "parent-child"]] }),
    merged(alpha, "kid-open", { parent: "e-1", deps: [["e-1", "parent-child"]] }),
    merged(beta, "b-open"),
  ];
  const openOnes = ["alpha:kid-open", "alpha:open-1", "alpha:waiting", "beta:b-open"];
  const closedOnes = ["alpha:blocker", "alpha:kid-done", "alpha:old", "alpha:recent"];
  const everyTask = [...openOnes, ...closedOnes];
  const all = await allProjectsPage(allBeads);

  await page.goto(`${base}/all`);
  await settled(openOnes);
  assert.equal(await selected(), "Hidden", "all board: the selector reads Hidden by default");
  assert.equal(await page.locator("section", { hasText: "Done" }).count(), 1, "all board: the Done column is on screen");
  assert.equal(await columnOf("alpha:waiting"), "Ready", "all board: a bead whose only blocker is closed sits in Ready, not Blocked");
  assert.equal(params().has("done"), false, "all board: the default is not written to the address");

  await page.goto(`${base}/all?view=list`);
  await settled(openOnes);
  assert.equal(await selected(), "Hidden", "all list: the same selector reads Hidden by default");
  assert.match(
    await page.locator("label", { has: selector() }).innerText(),
    /^Done\b/,
    "all list: the selector is labelled Done, since no Done column is beside it",
  );

  await page.goto(`${base}/all?view=epics`);
  await page.locator('[data-epic-id="alpha:e-1"]').getByText("1/2 done").waitFor();

  // Choosing a window on the board, carrying it to the list through the sidebar, and back.
  await page.goto(`${base}/all`);
  await settled(openOnes);
  await selector().selectOption("7");
  await settled([...openOnes, "alpha:recent"]);
  assert.equal(params().get("done"), "7", "all board: choosing 7 days writes done=7");
  assert.equal(await selected(), "Last 7 days");
  await page.locator("aside nav").getByRole("button", { name: /^List/ }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "list");
  await settled([...openOnes, "alpha:recent"]);
  assert.equal(params().get("done"), "7", "switching views keeps the window");
  assert.equal(await selected(), "Last 7 days", "all list: the window held after switching views");
  await selector().selectOption("");
  await settled(everyTask);
  assert.equal(params().get("done"), "all", "all list: choosing All time writes done=all");
  await selector().selectOption("none");
  await settled(openOnes);
  assert.equal(params().has("done"), false, "all list: choosing Hidden removes the parameter");
  await page.locator("aside nav").getByRole("button", { name: /^Board/ }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "board");
  await settled(openOnes);

  await page.goto(`${base}/all?done=28`);
  await settled([...openOnes, "alpha:recent"]);
  assert.equal(await selected(), "Last 4 weeks", "reload: done=28 reads as Last 4 weeks");
  await page.reload();
  await settled([...openOnes, "alpha:recent"]);
  assert.equal(await selected(), "Last 4 weeks", "reload: the window survives a reload");

  await page.goto(`${base}/all?done=all`);
  await settled(everyTask);
  assert.equal(await selected(), "All time", "done=all shows everything on the all-projects page");
  await page.goto(`${base}/all?view=list&done=all`);
  await settled(everyTask);
  await page.goto(`${base}/all?done=nonsense`);
  await settled(openOnes);
  assert.equal(await selected(), "Hidden", "an unrecognised value reads as the page's default");
  assert.equal(all.writes.length, 0, "the test sent no write");
  await all.context.close();

  console.log("PASS (browser): all-projects page hides closed beads by default, window on board and list, in the address");

  console.log("PASS (browser): a single project's page keeps all time, gains Hidden on the board, list unaffected");
} catch (error) {
  const body = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error({ url: page?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
