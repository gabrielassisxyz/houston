// Entry points to /sprints: a launcher card (one or more registered projects, after the
// all-projects card), a project-switcher item (one or more recent projects) and a link in the
// header of /all. The project list and every project and all-projects API response are answered
// from fixtures through page.route, so the project the server registered from its own checkout is
// never opened. Requests are counted before each click: the entries themselves fetch nothing.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const demo = { id: "demo", name: "Demo", path: null, hasBeads: true };
const registered = (id, name) => ({ id, name, path: `/fixture/${id}`, hasBeads: true });
const alpha = registered("alpha", "Alpha App");
const beta = registered("beta", "Beta Tools");

let projects = [demo];
const unexpected = [];
// Requests for sprint or merged data, each with the page it was made from. The pages that show
// that data make them; a launcher or a switcher that does is fetching for an entry that only
// navigates.
const dataFetches = [];

const browser = await chromium.launch();
let page;

async function installFixtures(context) {
  await context.route("**/api/**", (route) => {
    unexpected.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "not a fixture" } });
  });
  await context.route("**/api/projects", (route) => route.fulfill({ json: { projects } }));
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
  const recordAndAbort = (route) => {
    dataFetches.push({ url: new URL(route.request().url()).pathname, from: new URL(page.url()).pathname });
    return route.abort();
  };
  await context.route("**/api/all/**", recordAndAbort);
  await context.route("**/api/sprints**", recordAndAbort);
}

const sprintsCard = () => page.getByRole("button", { name: /^Sprints/ });
const switcherItem = () => page.getByRole("menuitem", { name: "Sprints", exact: true });
const atSprints = (url) => url.pathname === "/sprints";
// Requests the shell makes on its own and that read no tracker.
const shell = /\/api\/viewer-mode(\?|$)/;
const stray = () => [
  ...unexpected.filter((url) => !shell.test(url)),
  ...dataFetches.filter((f) => f.from !== "/sprints" && f.from !== "/all").map((f) => `${f.url} from ${f.from}`),
];

async function openLauncher(list) {
  projects = list;
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
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

  // Launcher, no real project: no card.
  await openLauncher([demo]);
  assert.equal(await sprintsCard().count(), 0, "launcher has no Sprints card without a real project");

  // Launcher, one real project: the card shows and leads to /sprints.
  await openLauncher([demo, alpha]);
  assert.equal(await sprintsCard().count(), 1, "launcher shows one Sprints card with one project");
  assert.deepEqual(stray(), [], "rendering the launcher fetched nothing beyond its fixtures");
  await sprintsCard().click();
  await page.waitForURL(atSprints);

  // Launcher, two real projects: All projects stays first, Sprints follows it.
  await openLauncher([demo, alpha, beta]);
  const cards = await page.locator('[role="button"][tabindex="0"]').allInnerTexts();
  assert.match(cards[0], /^All projects/, "the all-projects card is still first");
  assert.match(cards[1], /^Sprints/, "the Sprints card follows the all-projects card");
  assert.equal(await sprintsCard().count(), 1, "exactly one Sprints card with two projects");

  // Switcher, one recent project: the item shows and leads to /sprints.
  await openSwitcher([demo, alpha]);
  assert.equal(await switcherItem().count(), 1, "switcher lists Sprints with one project");
  assert.deepEqual(stray(), [], "opening the switcher fetched nothing beyond its fixtures");
  await switcherItem().click();
  await page.waitForURL(atSprints);

  // Switcher, two recent projects: still there, and All projects precedes it.
  await openSwitcher([demo, alpha, beta]);
  const items = await page.getByRole("menuitem").allInnerTexts();
  assert.ok(
    items.indexOf("All projects") >= 0 && items.indexOf("Sprints") === items.indexOf("All projects") + 1,
    `Sprints follows All projects in the switcher, saw ${JSON.stringify(items)}`,
  );
  await page.keyboard.press("Escape");

  // /all: the way to the sprints is the sidebar's switcher, as on a project's page.
  projects = [demo, alpha, beta];
  await page.goto(`${base}/all`);
  await page.getByRole("button", { name: "Select project, current project All projects", exact: true }).first().click();
  await switcherItem().waitFor();
  assert.equal(await page.getByRole("link", { name: "Sprints", exact: true }).count(), 0, "the header of /all carries no Sprints link");
  await switcherItem().click();
  await page.waitForURL(atSprints);

  console.log("PASS: Sprints card and switcher item appear as specified, on /all too, and lead to /sprints");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
