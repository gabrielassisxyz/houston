// The detail panel writes label edits one label at a time on br and demo projects and keeps the
// full-list PATCH only for bd. Every /api/p/ response is answered from fixtures and every
// request is recorded. Run through scripts/with-server.sh; no tracker is touched.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, labels) => ({
  id,
  title: `Task ${id}`,
  status: "open",
  issue_type: "task",
  priority: 2,
  labels,
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
});

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);

  let kind = "demo";
  let beads = [];
  let labelsRefusal = null;
  let writes = [];

  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (request.method() === "GET") {
      if (path.endsWith("/beads")) {
        return route.fulfill({
          json: {
            beads,
            meta: { kind, humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 },
          },
        });
      }
      return route.fulfill({ json: beads.find((entry) => path.endsWith(`/beads/${entry.id}`)) ?? {} });
    }
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    writes.push({ path: path.replace("/api/p/demo", ""), method: request.method(), body });
    if (path.endsWith("/labels") && labelsRefusal) {
      return route.fulfill({ status: 400, json: labelsRefusal });
    }
    return route.fulfill({ json: beads[0] });
  });

  async function openDrawer(nextKind, labels, { readOnly = false } = {}) {
    kind = nextKind;
    beads = [bead("t-1", labels)];
    writes = [];
    labelsRefusal = null;
    await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly } });
    await page.goto(`${base}/p/demo?view=board&archived=1`);
    await page.reload();
    await page.getByText("Task t-1", { exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("heading", { name: "Task t-1", exact: true }).waitFor();
    return { drawer, input: drawer.getByLabel("Add label", { exact: true }) };
  }

  const settle = () => page.waitForTimeout(400);
  const labelWrites = () => writes.filter((w) => w.path.endsWith("/labels"));
  const patchWrites = () => writes.filter((w) => w.method === "PATCH");

  for (const k of ["br", "demo"]) {
    // Add: one POST, nothing else; archived and the sprint label never travel.
    let { input } = await openDrawer(k, ["archived", "sprint:2026-11-23", "old"]);
    await input.fill("urgent");
    await input.press("Enter");
    await settle();
    assert.equal(writes.length, 1, `${k}: adding sends exactly one request, got ${JSON.stringify(writes)}`);
    assert.equal(writes[0].method, "POST", `${k}: add is a POST`);
    assert.equal(writes[0].path, "/beads/t-1/labels", `${k}: add goes to the labels route`);
    assert.deepEqual(writes[0].body, { add: ["urgent"], remove: [] }, `${k}: add body`);
    assert.equal(patchWrites().length, 0, `${k}: no PATCH on add`);

    // Chip remove button, on a chip that is neither the first nor the last: the request has to
    // name the chip that was clicked, not one picked by position.
    let page2 = await openDrawer(k, ["first", "urgent", "last"]);
    await page2.drawer.getByRole("button", { name: "Remove label urgent", exact: true }).click();
    await settle();
    assert.equal(writes.length, 1, `${k}: removing sends exactly one request`);
    assert.equal(writes[0].path, "/beads/t-1/labels");
    assert.deepEqual(writes[0].body, { add: [], remove: ["urgent"] }, `${k}: chip remove body`);

    // Backspace in the empty input removes the last chip.
    page2 = await openDrawer(k, ["other", "urgent"]);
    await page2.input.focus();
    await page2.input.press("Backspace");
    await settle();
    assert.equal(writes.length, 1, `${k}: backspace sends exactly one request`);
    assert.equal(writes[0].path, "/beads/t-1/labels");
    assert.deepEqual(writes[0].body, { add: [], remove: ["urgent"] }, `${k}: backspace body`);
  }

  // bd: the full list by PATCH, no labels route.
  {
    const { input } = await openDrawer("bd", ["a"]);
    await input.fill("urgent");
    await input.press("Enter");
    await settle();
    assert.equal(writes.length, 1, `bd: adding sends exactly one request, got ${JSON.stringify(writes)}`);
    assert.equal(writes[0].method, "PATCH", "bd: add is a PATCH");
    assert.deepEqual(writes[0].body, { labels: ["a", "urgent"] }, "bd: full list");
    assert.equal(labelWrites().length, 0, "bd: the labels route is not called");
  }

  // A refusal from the labels route is shown and the chips stay.
  {
    const { drawer, input } = await openDrawer("br", ["a"]);
    labelsRefusal = { error: "Label \"bad label\" holds a character the tracker refuses", code: "invalid_input" };
    await input.fill("bad label");
    await input.press("Enter");
    await page.getByText(/holds a character the tracker refuses/).first().waitFor();
    assert.equal(await drawer.getByRole("button", { name: "Remove label a", exact: true }).count(), 1, "chips unchanged");
    assert.equal(await drawer.getByRole("button", { name: /Remove label bad/ }).count(), 0, "refused label is no chip");
  }

  // Read-only: input disabled, nothing sent.
  {
    const { input } = await openDrawer("br", ["a"], { readOnly: true });
    assert.equal(await input.isDisabled(), true, "read-only: input disabled");
    await settle();
    assert.equal(writes.length, 0, "read-only: no request");
  }
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });

  console.log("PASS: br and demo send single-label edits; bd keeps the full-list PATCH; refusals shown; read-only inert");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
