// The all-projects page at /all never requests or offers a manual card order,
// while a single project's page keeps its manual order and run-order affordances.
// Every /api/** request is answered from fixtures and recorded.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

// The server refuses this exact id and the request check below looks for it, so a renamed
// constant would let that check pass with nothing checked.
const source = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
assert.match(
  source("lib/aggregate.ts"),
  /export const ALL_PROJECT_ID = "@all";/,
  "ALL_PROJECT_ID is exported from lib/aggregate.ts with the value @all",
);
assert.doesNotMatch(
  source("components/all-projects-shell.tsx"),
  /const ALL_PROJECT_ID\s*=/,
  "the shell imports ALL_PROJECT_ID and does not define its own",
);

const CREATED = "2026-09-01T00:00:00Z";
const alpha = { id: "alpha", name: "Alpha App" };
const beta = { id: "beta", name: "Beta Tools" };

function merged(project, local, fields = {}) {
  const id = `${project.id}:${local}`;
  return {
    id,
    local_id: local,
    project,
    title: fields.title ?? local,
    description: "",
    status: fields.status ?? "open",
    priority: fields.priority ?? 2,
    issue_type: fields.type ?? "task",
    labels: fields.labels ?? [],
    comments: [],
    dependencies: [],
    created_at: CREATED,
    updated_at: fields.updated_at ?? CREATED,
  };
}

// Ready holds four priorities (P0..P3) plus a same-priority P1 pair where the older
// bead precedes the newer one in the fixture. That separates Priority mode
// (priority asc, updated desc) from Manual-with-empty-order (priority asc, fixture
// order preserved) and from Recently updated mode (updated desc).
const mergedBeads = [
  merged(alpha, "p2-old", { title: "Alpha P2 old", priority: 2, updated_at: "2026-09-01T00:00:00Z" }),
  merged(beta, "p1-old", { title: "Beta P1 older", priority: 1, updated_at: "2026-09-02T00:00:00Z" }),
  merged(alpha, "p1-new", { title: "Alpha P1 newer", priority: 1, updated_at: "2026-09-06T00:00:00Z" }),
  merged(beta, "p0-mid", { title: "Beta P0 mid", priority: 0, updated_at: "2026-09-03T00:00:00Z" }),
  merged(alpha, "p3-newest", { title: "Alpha P3 newest", priority: 3, updated_at: "2026-09-08T00:00:00Z" }),
  merged(alpha, "e-1", { title: "Alpha epic", type: "epic", priority: 1, updated_at: "2026-09-04T00:00:00Z" }),
];

const PRIORITY_ORDER = [
  "beta:p0-mid",
  "alpha:p1-new",
  "beta:p1-old",
  "alpha:p2-old",
  "alpha:p3-newest",
];

const UPDATED_ORDER = [
  "alpha:p3-newest",
  "alpha:p1-new",
  "beta:p0-mid",
  "beta:p1-old",
  "alpha:p2-old",
];

const demoBeads = [
  {
    id: "demo-1",
    title: "Demo ready task",
    description: "",
    status: "open",
    priority: 1,
    issue_type: "task",
    labels: [],
    comments: [],
    dependencies: [],
    created_at: CREATED,
    updated_at: "2026-09-02T00:00:00Z",
  },
  {
    id: "demo-2",
    title: "Demo second task",
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    labels: [],
    comments: [],
    dependencies: [],
    created_at: CREATED,
    updated_at: "2026-09-03T00:00:00Z",
  },
];

const allMeta = {
  kind: "all",
  readOnly: true,
  humanActor: "reviewer",
  humanAllowlist: ["reviewer"],
  pollIntervalMs: 300_000,
  projects: [
    { ...alpha, kind: "br", count: 4 },
    { ...beta, kind: "bd", count: 2 },
  ],
  failed: [],
};

const demoMeta = {
  kind: "demo",
  humanActor: "reviewer",
  humanAllowlist: ["reviewer"],
  pollIntervalMs: 300_000,
};

function isAllProjectApiPath(url) {
  const { pathname } = new URL(url);
  // No real project id starts with "@", so any such path is a request made for the page itself.
  if (pathname.startsWith("/api/p/@")) return true;
  if (pathname.toLowerCase().startsWith("/api/p/%40")) return true;
  try {
    if (decodeURIComponent(pathname).startsWith("/api/p/@")) return true;
  } catch {
    // Malformed percent-encoding is still checked literally above.
  }
  return false;
}

const browser = await chromium.launch();
let activePage;

async function openScenario(url, { storedPrefs } = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(10_000);

  const requests = [];
  const errors = [];
  page.on("request", (req) => requests.push({ method: req.method(), url: req.url() }));
  page.on("pageerror", (err) => errors.push(err.message));

  if (storedPrefs !== undefined) {
    await page.addInitScript((value) => {
      localStorage.setItem("bmus.board", JSON.stringify(value));
    }, storedPrefs);
  }

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (pathname === "/api/viewer-mode") {
      return route.fulfill({ json: { readOnly: false } });
    }
    if (pathname === "/api/projects") {
      return route.fulfill({ json: { projects: [{ id: "demo", name: "Demo", kind: "demo" }] } });
    }
    if (pathname === "/api/all/beads/stream") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "retry: 60000\n: connected\n\n",
      });
    }
    if (pathname === "/api/all/beads") {
      return route.fulfill({ json: { beads: mergedBeads, meta: allMeta } });
    }
    if (pathname === "/api/p/demo/beads/stream") {
      return route.abort();
    }
    if (pathname === "/api/p/demo/beads") {
      return route.fulfill({ json: { beads: demoBeads, meta: demoMeta } });
    }
    if (pathname === "/api/p/demo/order") {
      return route.fulfill({ json: { orders: {} } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(`${base}${url}`);
  return { context, page, requests, errors };
}

function sortSelect(page) {
  return page.getByLabel("Sort board cards", { exact: true });
}

async function readOptions(page) {
  return sortSelect(page)
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => ({ value: o.value, label: o.textContent?.trim() ?? "" })));
}

async function readyIds(page) {
  const readyCol = page.getByText("Ready", { exact: true }).locator("xpath=ancestor::section[1]");
  return readyCol
    .locator("article")
    .evaluateAll((cards) => cards.map((card) => card.dataset.keyboardBeadId));
}

async function readStoredPrefs(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("bmus.board");
    return raw ? JSON.parse(raw) : null;
  });
}

try {
  // 1. Merged board with stored Manual: no @all API request, two sort options, shown as
  //    Priority, sorted by Priority (including tie-breaker), stored preference untouched,
  //    tooltip omits "reorder".
  const allRecorded = [];
  {
    const { context, page, requests, errors } = await openScenario("/all", {
      storedPrefs: { sortMode: "manual" },
    });
    await page.locator('[data-keyboard-bead-id="beta:p0-mid"]').waitFor();
    await page.waitForTimeout(250);

    const options = await readOptions(page);
    assert.deepEqual(
      options,
      [
        { value: "priority", label: "Priority" },
        { value: "updated", label: "Recently updated" },
      ],
      "merged board sort select offers exactly Priority and Recently updated",
    );

    assert.equal(
      await sortSelect(page).inputValue(),
      "priority",
      "stored Manual is shown as Priority on the merged board",
    );
    assert.deepEqual(
      await readyIds(page),
      PRIORITY_ORDER,
      "stored Manual sorts merged board cards in Priority order",
    );

    const storedAfter = await readStoredPrefs(page);
    assert.equal(
      storedAfter?.sortMode,
      "manual",
      "visiting the merged board does not overwrite stored Manual in localStorage",
    );

    const tooltip = await sortSelect(page).locator("xpath=ancestor::label[1]").getAttribute("title");
    assert.ok(tooltip && tooltip.length > 0, "merged board sort control still has a tooltip");
    assert.ok(
      !tooltip.toLowerCase().includes("reorder"),
      `merged board sort tooltip must not mention reorder, got: ${tooltip}`,
    );

    assert.deepEqual(errors, [], "no page errors on merged board");
    allRecorded.push(...requests);
    await context.close();
  }

  // 2. Merged list view: no @all API request, subtitle is "N beads" without "run-order".
  {
    const { context, page, requests, errors } = await openScenario("/all?view=list");
    await page.locator('[data-keyboard-bead-id="beta:p0-mid"]').waitFor();
    await page.waitForTimeout(250);

    const subtitle = await page
      .locator("main header h1", { hasText: "List" })
      .locator("xpath=following-sibling::span[1]")
      .innerText();
    assert.equal(subtitle.trim(), "5 beads", "merged list subtitle shows only the bead count");
    assert.ok(
      !subtitle.toLowerCase().includes("run-order"),
      `merged list subtitle must not mention run-order, got: ${subtitle}`,
    );

    assert.deepEqual(errors, [], "no page errors on merged list");
    allRecorded.push(...requests);
    await context.close();
  }

  // 3. Merged epics view: no @all API request.
  {
    const { context, page, requests, errors } = await openScenario("/all?view=epics");
    await page.locator('[data-epic-id="alpha:e-1"]').waitFor();
    await page.waitForTimeout(250);

    assert.deepEqual(errors, [], "no page errors on merged epics");
    allRecorded.push(...requests);
    await context.close();
  }

  const badAllRequests = allRecorded.filter((r) => isAllProjectApiPath(r.url));
  assert.deepEqual(
    badAllRequests,
    [],
    "none of the merged page's views may request /api/p/@all or its percent-encoded form",
  );
  assert.ok(
    allRecorded.some((r) => new URL(r.url).pathname === "/api/all/beads"),
    "the merged page fetched /api/all/beads",
  );

  // 4. Merged board with stored Priority.
  {
    const { context, page, errors } = await openScenario("/all", {
      storedPrefs: { sortMode: "priority" },
    });
    await page.locator('[data-keyboard-bead-id="beta:p0-mid"]').waitFor();
    assert.equal(await sortSelect(page).inputValue(), "priority", "stored Priority stays selected");
    assert.deepEqual(await readyIds(page), PRIORITY_ORDER, "stored Priority sorts by priority");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 5. Merged board with stored Recently updated.
  {
    const { context, page, errors } = await openScenario("/all", {
      storedPrefs: { sortMode: "updated" },
    });
    await page.locator('[data-keyboard-bead-id="beta:p0-mid"]').waitFor();
    assert.equal(await sortSelect(page).inputValue(), "updated", "stored Recently updated stays selected");
    assert.deepEqual(await readyIds(page), UPDATED_ORDER, "stored Recently updated sorts by updated_at");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 6. Single project page (/p/demo): wait for viewer-mode, verify Manual is still offered,
  //    order request is still sent on board and list, and list subtitle still promises run-order.
  {
    const { context, page, requests, errors } = await openScenario("/p/demo?view=board", {
      storedPrefs: { sortMode: "manual" },
    });
    await page.locator('[data-keyboard-bead-id="demo-1"]').waitFor();
    // Wait until viewer-mode has answered so no control is hidden for the wrong reason.
    await page.getByRole("button", { name: /^New/ }).waitFor();

    const options = await readOptions(page);
    assert.deepEqual(
      options,
      [
        { value: "priority", label: "Priority" },
        { value: "updated", label: "Recently updated" },
        { value: "manual", label: "Manual" },
      ],
      "project board keeps all three sort options including Manual",
    );
    assert.equal(await sortSelect(page).inputValue(), "manual", "project board keeps Manual selected");
    assert.ok(
      requests.some((r) => r.method === "GET" && new URL(r.url).pathname === "/api/p/demo/order"),
      "project board still requests /api/p/demo/order",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }

  {
    const { context, page, requests, errors } = await openScenario("/p/demo?view=list");
    await page.locator('[data-keyboard-bead-id="demo-1"]').waitFor();
    await page.getByRole("button", { name: /^New/ }).waitFor();

    const subtitle = await page
      .locator("main header h1", { hasText: "List" })
      .locator("xpath=following-sibling::span[1]")
      .innerText();
    assert.ok(
      subtitle.includes("drag to set run-order"),
      `project list subtitle must keep drag to set run-order, got: ${subtitle}`,
    );
    assert.ok(
      requests.some((r) => r.method === "GET" && new URL(r.url).pathname === "/api/p/demo/order"),
      "project list still requests /api/p/demo/order",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log(
    `PASS: /all makes no /api/p/@all requests across board/list/epics (${allRecorded.length} requests checked), ` +
      "hides Manual while mapping stored Manual to Priority without rewriting storage, omits run-order/reorder copy, " +
      "and leaves /p/demo unchanged",
  );
} catch (error) {
  const body = activePage ? await activePage.locator("body").innerText().catch(() => "") : "";
  console.error({ url: activePage?.url(), body: body.slice(0, 3000) });
  throw error;
} finally {
  await browser.close();
}
