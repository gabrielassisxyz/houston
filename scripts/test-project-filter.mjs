// The project facet of the shared filter model. Two halves: the pure model (matching, AND with
// another facet, the URL round trip, the option list) loads lib/filters.ts without a build; the
// browser half runs only when SCOTTY_TEST_URL is set, answers every /api/p/* response from
// fixtures on the demo project's page, and drives the board and the list on a tagged page and on
// an untagged one.
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
const { emptyFilters, filtersFromSearchParams, writeFiltersToSearchParams, matchesFilters, projectOptionsFrom, activeFilterCount } =
  load("../lib/filters.ts");

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

const alpha = { id: "alpha", name: "Alpha Repo" };
const zeta = { id: "zeta", name: "Zeta Repo" };
const withProjects = (projects) => ({ ...emptyFilters, projects });
const keep = (filters, beads) => beads.filter((b) => matchesFilters(b, filters, [])).map((b) => b.id);

// ---- pure half ----
{
  const inA = tag(alpha, "1");
  const inB = tag(zeta, "2");
  const loose = bead("3");
  const all = [inA, inB, loose];
  assert.deepEqual(keep(withProjects(["alpha"]), all), ["alpha:1"], "one project keeps its own beads only");
  assert.deepEqual(keep(withProjects(["alpha", "zeta"]), all), ["alpha:1", "zeta:2"], "several projects are OR-ed and the untagged bead is dropped");
  assert.deepEqual(keep(withProjects([]), all), ["alpha:1", "zeta:2", "3"], "no project chosen keeps every bead");
  assert.deepEqual(keep(withProjects([""]), all), [], "an empty id is not a way to select untagged beads");

  const mixed = [tag(alpha, "open"), tag(alpha, "done", { status: "closed" }), tag(zeta, "open")];
  assert.deepEqual(
    keep({ ...withProjects(["alpha"]), status: ["open"] }, mixed),
    ["alpha:open"],
    "the project facet is AND-ed with another facet",
  );
  assert.equal(activeFilterCount(withProjects(["alpha", "zeta"])), 2, "chosen projects count as active selections");

  const parsed = filtersFromSearchParams(new URLSearchParams("project=alpha&project=zeta&project=alpha&project="));
  assert.deepEqual(plain(parsed.projects), ["alpha", "zeta"], "the project parameter is repeated, distinct and non-empty");
  const url = new URLSearchParams("view=list&bead=x&custom=keep&status=open&project=stale");
  writeFiltersToSearchParams(url, { ...filtersFromSearchParams(new URLSearchParams("status=open")), projects: ["alpha", "zeta"] });
  assert.deepEqual(url.getAll("project"), ["alpha", "zeta"], "writing replaces the project parameters");
  assert.deepEqual(url.getAll("status"), ["open"], "writing leaves the other filter parameters as they were");
  for (const [key, value] of [["view", "list"], ["bead", "x"], ["custom", "keep"]]) assert.equal(url.get(key), value);
  const cleared = new URLSearchParams("project=alpha&status=open");
  writeFiltersToSearchParams(cleared, emptyFilters);
  assert.equal(cleared.has("project"), false, "empty filters remove the project parameter");

  assert.deepEqual(
    plain(projectOptionsFrom([tag(zeta, "1"), tag(alpha, "1"), tag(zeta, "2"), bead("x")])),
    [{ value: "alpha", label: "Alpha Repo" }, { value: "zeta", label: "Zeta Repo" }],
    "options are one per project, ordered by name, with the id as the value",
  );
  assert.deepEqual(plain(projectOptionsFrom([bead("a"), bead("b")])), [], "no tagged bead, no options");
  console.log("PASS (pure): project matching, AND with another facet, URL round trip, options");
}

const base = process.env.SCOTTY_TEST_URL;
if (!base) {
  console.log("SKIP (browser): SCOTTY_TEST_URL is not set");
  process.exit(0);
}
const { chromium } = await import("playwright");

const tagged = [
  tag(alpha, "a-open"),
  tag(alpha, "a-wip", { status: "in_progress" }),
  tag(zeta, "z-open"),
  tag(zeta, "z-wip", { status: "in_progress" }),
];
const untagged = [bead("u-one"), bead("u-two", { status: "in_progress" })];

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let beads = [];
  const writes = [];
  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (request.method() !== "GET") {
      writes.push({ path, method: request.method() });
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/beads")) {
      return route.fulfill({
        json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 } },
      });
    }
    return route.fulfill({ json: {} });
  });

  const ids = async (view) =>
    (await page.locator(view === "board" ? "article[data-keyboard-bead-id]" : "[data-keyboard-bead-id]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-keyboard-bead-id")),
    )).sort();
  const open = async (view, nextBeads, query = "") => {
    beads = nextBeads;
    await page.goto(`${base}/p/demo?view=${view}${query}`);
    await page.reload();
  };
  const projectButton = () => page.getByRole("button", { name: /^Project/ });
  const clearButton = () => page.getByRole("button", { name: /^Clear · / });
  const params = () => new URL(page.url()).searchParams;
  const settle = (view, count) =>
    page.waitForFunction(
      ([selector, n]) => document.querySelectorAll(selector).length === n,
      [view === "board" ? "article[data-keyboard-bead-id]" : "[data-keyboard-bead-id]", count],
    );
  const pick = async (label) => {
    await projectButton().click();
    await page.getByRole("menuitemcheckbox", { name: label }).click();
    await page.keyboard.press("Escape");
  };

  for (const view of ["board", "list"]) {
    // ---- tagged page: the facet appears, narrows, writes the URL, counts, clears ----
    await open(view, tagged);
    await settle(view, 4);
    await projectButton().waitFor();
    assert.equal(await clearButton().count(), 0, `${view}: nothing is active at first`);
    await projectButton().click();
    await page.getByRole("menuitemcheckbox").first().waitFor();
    assert.deepEqual(
      await page.getByRole("menuitemcheckbox").allInnerTexts(),
      [alpha.name, zeta.name],
      `${view}: the facet lists the project names, ordered by name`,
    );
    await page.keyboard.press("Escape");

    await pick(alpha.name);
    await settle(view, 2);
    assert.deepEqual(await ids(view), ["alpha:a-open", "alpha:a-wip"], `${view}: only the chosen project's beads remain`);
    assert.deepEqual(params().getAll("project"), ["alpha"], `${view}: the URL carries the project id`);
    await clearButton().waitFor();
    assert.equal(await clearButton().innerText(), "Clear · 1", `${view}: the facet raises the active count by one`);

    await pick(zeta.name);
    await settle(view, 4);
    assert.deepEqual(params().getAll("project").sort(), ["alpha", "zeta"], `${view}: several projects can be chosen`);
    await pick(zeta.name);
    await settle(view, 2);

    // AND with another facet, through the real bar.
    await page.getByRole("button", { name: /^Status/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "In Progress" }).click();
    await page.keyboard.press("Escape");
    await settle(view, 1);
    assert.deepEqual(await ids(view), ["alpha:a-wip"], `${view}: project AND status`);
    assert.equal(await clearButton().innerText(), "Clear · 2", `${view}: two facets count as two`);

    // A reload with the parameter in the address starts narrowed and shows the filter as active.
    await page.reload();
    await settle(view, 1);
    assert.deepEqual(await ids(view), ["alpha:a-wip"], `${view}: a reload keeps the narrowing`);
    assert.equal(await clearButton().innerText(), "Clear · 2", `${view}: a reload keeps the count`);
    assert.match(await projectButton().innerText(), /1/, `${view}: the Project filter shows one selection after a reload`);

    await clearButton().click();
    await settle(view, 4);
    assert.equal(params().has("project"), false, `${view}: clearing the filters removes the project parameter`);
    assert.equal(params().has("status"), false, `${view}: clearing the filters removes the others too`);

    // A deep link with the parameter alone.
    await open(view, tagged, "&project=zeta");
    await settle(view, 2);
    assert.deepEqual(await ids(view), ["zeta:z-open", "zeta:z-wip"], `${view}: ?project=zeta narrows on first load`);
    assert.equal(await clearButton().innerText(), "Clear · 1", `${view}: the deep link shows as active`);

    // ---- untagged page: no facet, no parameter ----
    await open(view, untagged);
    await settle(view, 2);
    assert.equal(await projectButton().count(), 0, `${view}: no Project filter without tagged beads`);
    await page.getByRole("button", { name: /^Status/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "In Progress" }).click();
    await page.keyboard.press("Escape");
    await settle(view, 1);
    assert.equal(params().has("project"), false, `${view}: picking another filter adds no project parameter`);
    await clearButton().click();
    await settle(view, 2);
    assert.equal(params().has("project"), false, `${view}: clearing adds no project parameter`);

    // A stale project parameter on an untagged page matches nothing (an untagged bead matches only an
    // empty facet), but the bar counts it, so Clear is offered and removes it.
    await open(view, untagged, "&project=gone");
    await page.waitForFunction(() => document.querySelectorAll("[data-keyboard-bead-id]").length === 0);
    assert.equal(await projectButton().count(), 0, `${view}: still no Project filter on the untagged page`);
    assert.equal(await clearButton().innerText(), "Clear · 1", `${view}: the stale parameter is counted, so it can be cleared`);
    await clearButton().click();
    await settle(view, 2);
    assert.equal(params().has("project"), false, `${view}: Clear removes the stale parameter`);
  }

  assert.equal(writes.length, 0, "the test sent no write");
  console.log("PASS (browser): project facet on the board and the list, tagged and untagged");
} catch (error) {
  console.error({ url: page?.url(), body: page ? (await page.locator("body").innerText()).slice(0, 3000) : "" });
  throw error;
} finally {
  await browser.close();
}
