// The project chip and the original id on the three bead faces (card, list row, epic header and
// child row). Beads of the merged board carry `project` and `local_id` and a namespaced `id`; the
// faces must show the chip and `local_id`, copy `local_id`, and keep the namespaced id in every
// key and data attribute. Beads without those fields must render exactly as before.
// Every /api/p/* response is answered from fixtures; the demo project's page hosts all of it.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const SIXTY = "P".repeat(60);

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

const tag = (project, localId, extra = {}) =>
  bead(`${project.id}:${localId}`, { title: `Task ${localId}`, local_id: localId, project, ...extra });

const alpha = { id: "alpha", name: "Alpha Project" };
const child = (parentId) => [{ type: "parent-child", depends_on_id: parentId, issue_id: "x" }];

const tagged = [
  tag(alpha, "ab-1"),
  tag(alpha, "ab-epic", { issue_type: "epic", title: "Epic ab-epic" }),
  tag(alpha, "ab-kid", { dependencies: child("alpha:ab-epic") }),
];
const untagged = [
  bead("ab-1"),
  bead("ab-epic", { issue_type: "epic", title: "Epic ab-epic" }),
  bead("ab-kid", { dependencies: child("ab-epic") }),
];

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);

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
            meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 },
          },
        });
      }
      return route.fulfill({ json: beads.find((entry) => path.endsWith(`/beads/${entry.id}`)) ?? {} });
    }
    writes.push({ path, method: request.method() });
    return route.fulfill({ json: {} });
  });

  async function open(view, nextBeads) {
    beads = nextBeads;
    await page.goto(`${base}/p/demo?view=${view}`);
    await page.reload();
  }

  const card = (id) => page.locator(`article[data-keyboard-bead-id="${id}"]`);
  const row = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);

  async function openEpic(epicId, kidId) {
    await open("epics", beads);
    await row(epicId).waitFor();
    await row(epicId).click();
    await row(kidId).waitFor();
  }

  const chipTexts = (locator) => locator.locator("[data-project-chip]").allInnerTexts();

  // ---- tagged beads: chip and original id on all four faces ----
  async function assertFace(name, locator, localId) {
    const text = await locator.innerText();
    assert.deepEqual(await chipTexts(locator), [alpha.name], `${name} shows one chip with the project name`);
    assert.ok(text.includes(localId), `${name} shows ${localId}`);
    assert.ok(!text.includes("alpha:"), `${name} text has no namespaced id: ${text}`);
  }
  await open("board", tagged);
  await card("alpha:ab-1").waitFor();
  await assertFace("card", card("alpha:ab-1"), "ab-1");
  assert.equal(
    await card("alpha:ab-kid").locator('[title*="Epic ab-epic"]').getAttribute("title"),
    "ab-epic · Epic ab-epic",
    "the card's parent tooltip uses the original id",
  );
  await open("list", tagged);
  await row("alpha:ab-1").waitFor();
  await assertFace("list row", row("alpha:ab-1"), "ab-1");
  assert.equal(
    await row("alpha:ab-kid").locator('[title*="Epic ab-epic"]').getAttribute("title"),
    "ab-epic · Epic ab-epic · P2",
    "the list row's parent tooltip uses the original id",
  );
  await openEpic("alpha:ab-epic", "alpha:ab-kid");
  await assertFace("epic header", row("alpha:ab-epic"), "ab-epic");
  await assertFace("epic child row", row("alpha:ab-kid"), "ab-kid");
  assert.equal(
    await row("alpha:ab-epic").getByRole("button", { name: "Details" }).getAttribute("aria-label"),
    "Open details for ab-epic",
    "the epic's details label uses the original id",
  );

  // ---- the clipboard gets the original id; the keyboard attribute keeps the namespaced one ----
  await open("board", tagged);
  await card("alpha:ab-1").waitFor();
  await card("alpha:ab-1").getByRole("button", { name: "ab-1", exact: true }).click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) === "ab-1");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "ab-1", "clipboard holds local_id");

  // The copy that follows the pointer is a fourth rendering of the card's id.
  const box = await card("alpha:ab-1").boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 80, { steps: 5 });
  await page.mouse.move(box.x + 80, box.y + 120, { steps: 5 });
  const overlay = page.locator('article[aria-hidden="true"]');
  await overlay.waitFor();
  const dragged = await overlay.innerText();
  assert.ok(dragged.includes("ab-1") && !dragged.includes("alpha:"), `drag preview shows the original id: ${dragged}`);
  assert.deepEqual(await chipTexts(overlay), [alpha.name], "drag preview shows the project chip");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await card("alpha:ab-1").count(), 1, "data-keyboard-bead-id keeps the namespaced id");
  assert.equal(await page.locator('[data-keyboard-bead-id="ab-1"]').count(), 0, "no face is keyed by the original id");

  // ---- untagged beads: no chip, and the text is what it was before this change ----
  const untaggedText = {};
  await open("board", untagged);
  await card("ab-1").waitFor();
  untaggedText.card = await card("ab-1").innerText();
  assert.equal(await page.locator("[data-project-chip]").count(), 0, "board renders no chip");
  await open("list", untagged);
  await row("ab-1").waitFor();
  untaggedText.list = await row("ab-1").innerText();
  assert.equal(await page.locator("[data-project-chip]").count(), 0, "list renders no chip");
  await openEpic("ab-epic", "ab-kid");
  untaggedText.epic = await row("ab-epic").innerText();
  untaggedText.kid = await row("ab-kid").innerText();
  assert.equal(await page.locator("[data-project-chip]").count(), 0, "epics render no chip");
  const expected = {
    card: "ab-1\nMedium\nTask ab-1\nTask\n?\nUnassigned",
    list: "ab-1\nTask ab-1\nMedium\n?\nUnassigned",
    epic: "ab-epic\nOpen\nMedium\nEpic ab-epic\n0%\n0/1 done\nDetails",
    kid: "ab-kid\nTask ab-kid\nMedium\n?",
  };
  for (const key of Object.keys(expected)) {
    // The list row ends with a relative time that depends on the clock.
    const text = untaggedText[key].trim().replace(/\n[^\n]* ago$/, "");
    assert.equal(text, expected[key], `untagged ${key} text is unchanged`);
  }

  // ---- a 60 character project name truncates instead of widening the face ----
  const withName = (name) => [tag({ id: "longone", name }, "ab-1")];
  const measure = async (locator) =>
    locator.evaluate((el) => ({ width: el.getBoundingClientRect().width, overflow: el.scrollWidth - el.clientWidth }));
  for (const [name, view, locate] of [
    ["card", "board", () => card("longone:ab-1")],
    ["list row", "list", () => row("longone:ab-1")],
  ]) {
    await open(view, withName("Al"));
    await locate().waitFor();
    const short = await measure(locate());
    await open(view, withName(SIXTY));
    await locate().waitFor();
    const wide = await measure(locate());
    assert.equal(wide.width, short.width, `${name} keeps its width with a 60 character project name`);
    assert.ok(wide.overflow <= 0, `${name} does not overflow horizontally (${wide.overflow}px)`);
    const chip = await measure(locate().locator("[data-project-chip]"));
    assert.ok(chip.width <= 120, `${name} chip is capped (${chip.width}px)`);
  }

  assert.equal(writes.length, 0, "the test sent no write");
  console.log("PASS: chip and original id on card, list row and epic rows; clipboard; untagged unchanged; truncation; keyboard id");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
