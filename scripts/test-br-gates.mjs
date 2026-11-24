// Trackers without human approval gates (br): the drawer must not offer "Require approval" and the
// Needs You inbox must not point at `bd gate create`; bd and demo projects keep both.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status: "open",
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...extra,
});

const needsYouTab = (page) => page.getByRole("button", { name: /^Needs You(?:\s+\d+)?$/ });

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);

  let kind = "demo";
  let beads = [];
  const writes = [];

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
    writes.push({ path, method: request.method() });
    return route.fulfill({ json: {} });
  });

  async function open(nextKind, nextBeads) {
    kind = nextKind;
    beads = nextBeads;
    await page.goto(`${base}/p/demo`);
    await page.reload();
  }

  await open("demo", []);
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });

  const emptyInbox = async (k) => {
    await open(k, [bead("plain-1")]);
    await needsYouTab(page).click();
    await page.getByText("Nothing needs you right now.").waitFor();
    return page.getByText("Nothing needs you right now.").locator("xpath=..").innerText();
  };

  const requireApproval = async (k) => {
    await open(k, [bead("plain-1")]);
    await page.getByText("Task plain-1", { exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("heading", { name: "Task plain-1", exact: true }).waitFor();
    // The control sits in the dependencies section; wait for a sibling that always renders.
    await drawer.getByText(/Subtasks/i).first().waitFor();
    return drawer.getByRole("button", { name: "Require approval", exact: true });
  };

  // Drawer: absent on br, present on bd and demo.
  assert.equal(await (await requireApproval("br")).count(), 0, "br drawer offers no Require approval");
  for (const k of ["bd", "demo"]) {
    const control = await requireApproval(k);
    await control.waitFor();
    assert.equal(await control.count(), 1, `${k} drawer still offers Require approval`);
  }

  // Empty inbox text.
  const brEmpty = await emptyInbox("br");
  assert.ok(!brEmpty.includes("bd gate create"), "br empty inbox does not mention bd gate create");
  assert.ok(!brEmpty.includes("bd human"), "br empty inbox does not mention bd human");
  assert.match(brEmpty, /Issues labelled human appear here\./);
  for (const k of ["bd", "demo"]) {
    const text = await emptyInbox(k);
    assert.match(text, /bd gate create --type human/, `${k} empty inbox keeps the gate command`);
    assert.match(text, /Agents flag beads here with bd human/, `${k} empty inbox keeps the bd human text`);
    assert.ok(!/Issues labelled human/.test(text), `${k} empty inbox has no br text`);
  }

  // A human-labelled bead on br still lands in the inbox with respond and dismiss.
  await open("br", [bead("human-1", { labels: ["human"] })]);
  await needsYouTab(page).click();
  const card = page.locator('[data-keyboard-bead-id="human-1"]');
  await card.waitFor();
  await card.getByRole("button", { name: "Respond", exact: true }).waitFor();
  await card.getByRole("button", { name: "Dismiss", exact: true }).waitFor();
  assert.equal(await page.getByText("Nothing needs you right now.").count(), 0, "br inbox is not empty");
  assert.equal(writes.length, 0, "the test sent no write");

  console.log("PASS: br hides Require approval and the bd gate text; bd/demo keep both; human-labelled inbox works on br");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
