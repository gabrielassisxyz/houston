// Entry points to /all: a launcher card and a project-switcher item, both shown only with two or
// more registered projects (the built-in demo does not count). The project list and every project
// and all-projects API response are answered from fixtures through page.route, so the project the
// server registered from its own checkout is never opened.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

// GET /api/projects always lists the built-in demo first, then the registered projects.
const demo = { id: "demo", name: "Demo", path: null, hasBeads: true };
const registered = (id, name) => ({ id, name, path: `/fixture/${id}`, hasBeads: true });
const alpha = registered("alpha", "Alpha App");
const beta = registered("beta", "Beta Tools");

let projects = [demo];
const unexpected = [];

const browser = await chromium.launch();
let page;

async function installFixtures(context) {
  await context.route("**/api/**", (route) => {
    unexpected.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "not a fixture" } });
  });
  await context.route("**/api/capabilities", (route) => {
    return route.fulfill({ json: { workDashboardUrl: null } });
  });
  await context.route("**/api/projects", (route) => {
    return route.fulfill({ json: { projects } });
  });
  await context.route("**/api/p/*/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/beads")) {
      return route.fulfill({
        json: { beads: [], meta: { kind: "br", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 } },
      });
    }
    return route.fulfill({ json: {} });
  });
  await context.route("**/api/all/**", (route) => route.abort());
}

const launcherCard = () => page.getByRole("button", { name: /^All projects/ });
const switcherItem = () => page.getByRole("menuitem", { name: "All projects", exact: true });

async function openLauncher(list) {
  projects = list;
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  // The grid replaces the spinner only once the list has arrived.
  await page.getByRole("button", { name: /^Demo/ }).waitFor();
}

async function openSwitcher(list) {
  projects = list;
  await page.goto(`${base}/p/alpha`);
  const trigger = page.getByRole("button", { name: /^Select project, current project/ }).first();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Project picker", exact: true }).waitFor();
}

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await installFixtures(context);

  // Launcher, two registered projects: the card is first, advertises editing, and opens /all.
  await openLauncher([demo, alpha, beta]);
  assert.equal(await launcherCard().count(), 1, "launcher shows one All projects card with two projects");
  const cardText = await launcherCard().innerText();
  assert.match(cardText, /Edit, move and create beads in any of them\./, "the card says the board edits across projects");
  assert.doesNotMatch(cardText, /read-only/i, "the card no longer says read-only");
  const firstCard = await page.locator('[role="button"][tabindex="0"]').first().innerText();
  assert.match(firstCard, /^All projects/, "the card comes first in the grid, before Demo");
  await launcherCard().click();
  await page.waitForURL((url) => url.pathname === "/all");

  // Launcher, one registered project and none: no card. Demo alone must not count either.
  for (const [label, list] of [
    ["no project", [demo]],
    ["one project", [demo, alpha]],
  ]) {
    await openLauncher(list);
    assert.equal(await launcherCard().count(), 0, `launcher has no All projects card with ${label}`);
  }

  // The demo is not a registered project: two entries of which one is the demo show nothing.
  await openLauncher([demo, alpha]);
  assert.equal(await launcherCard().count(), 0, "demo plus one project does not reach two");

  // Switcher, two registered projects: both items, each going to its own place.
  await openSwitcher([demo, alpha, beta]);
  assert.equal(await switcherItem().count(), 1, "switcher lists All projects with two projects");
  assert.equal(
    await page.getByRole("menuitem", { name: "Project picker", exact: true }).count(),
    1,
    "switcher lists Project picker",
  );
  await switcherItem().click();
  await page.waitForURL((url) => url.pathname === "/all");

  await openSwitcher([demo, alpha, beta]);
  await page.getByRole("menuitem", { name: "Project picker", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");

  // Switcher, one registered project and none: no entry, the picker stays.
  for (const [label, list] of [
    ["no project", [demo]],
    ["one project", [demo, alpha]],
  ]) {
    await openSwitcher(list);
    assert.equal(await switcherItem().count(), 0, `switcher has no All projects item with ${label}`);
    await page.keyboard.press("Escape");
  }

  // The shell's own viewer-mode call reads no tracker; anything else must be a fixture.
  const shell = /\/api\/viewer-mode(\?|$)/;
  assert.deepEqual(
    unexpected.filter((url) => !shell.test(url)),
    [],
    "every tracker API request was answered from a fixture",
  );
  console.log("PASS: All projects card and switcher item appear only with two registered projects, navigate to /all; Project picker leads to /");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
