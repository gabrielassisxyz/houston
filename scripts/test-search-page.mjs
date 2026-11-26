// The notes search page at /search: query box, tag/folder/kind filters, ranked
// results with snippets, paging, shortcut, and the unconfigured/unavailable
// states. Every /api/notes/search answer below comes from fixtures through
// page.route, except the cases that name the real proxy (kind=bogus,
// unavailable). Capabilities are fixtures too, except the unavailable case
// which sets a real notesServiceUrl on the isolated server.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { obsidianLink } from "../lib/obsidian-link.ts";

// The vault name is encoded as strictly as the path: a name holding `&` or `#`
// would otherwise end the vault parameter early. The browser fixtures name a
// vault with a space only, which every encoder writes the same way.
assert.equal(
  obsidianLink("Trabalho & Notas #1", "a b.md"),
  "obsidian://open?vault=Trabalho%20%26%20Notas%20%231&file=a%20b.md",
  "a vault name with & and # is encoded with encodeURIComponent",
);

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const STX = "";
const ETX = "";

const hit = (id, o = {}) => ({
  id,
  title: o.title ?? `Title of ${id}`,
  path: o.path ?? `work/${id}.md`,
  kind: o.kind ?? "nota",
  tags: o.tags ?? ["phase-3"],
  snippet: o.snippet ?? `before ${STX}${o.word ?? "rollout"}${ETX} after`,
});

function answer({ hits, total, limit = 20, offset = 0 }) {
  return { hits, total, limit, offset };
}

const browser = await chromium.launch();
let page;
let context;
let step = "start";

const OBS_VAULT = "My Vault";
const OBS_PATH = "notas/Café com espaço #1 & +.md";
const OBS_HREF = `obsidian://open?vault=${encodeURIComponent(OBS_VAULT)}&file=${encodeURIComponent(OBS_PATH)}`;

function decodeObsidian(href) {
  assert.ok(href.startsWith("obsidian://open?"), `obsidian scheme and path: ${href}`);
  const qs = href.slice("obsidian://open?".length);
  const parts = qs.split("&");
  assert.equal(parts.length, 2, `vault and file params: ${href}`);
  const params = {};
  for (const part of parts) {
    const i = part.indexOf("=");
    params[part.slice(0, i)] = part.slice(i + 1);
  }
  return { vault: decodeURIComponent(params.vault), file: decodeURIComponent(params.file) };
}

function capsBody(notes, vault = null) {
  return { workDashboardUrl: null, chain: false, notes, obsidianVault: vault };
}

async function newContext() {
  if (context) {
    try {
      await context.close();
    } catch {}
    context = null;
  }
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
}

async function installBase({ notes = true, vault = null } = {}) {
  await context.route("**/api/capabilities", (route) =>
    route.fulfill({ json: capsBody(notes, vault) }),
  );
  await context.route("**/api/viewer-mode", (route) =>
    route.fulfill({ json: { readOnly: false } }),
  );
  await context.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [
          { id: "alpha", name: "Alpha App", path: "/fixture/alpha", hasBeads: true },
          { id: "beta", name: "Beta Tools", path: "/fixture/beta", hasBeads: true },
        ],
      },
    }),
  );
  await context.route("**/api/p/*/beads", (route) =>
    route.fulfill({
      json: {
        beads: [],
        meta: { kind: "br", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 },
      },
    }),
  );
  await context.route("**/api/p/*/beads/stream", (route) => route.abort());
  await context.route("**/api/all/beads", (route) =>
    route.fulfill({
      json: {
        beads: [],
        meta: {
          kind: "all", readOnly: true, humanActor: "reviewer", humanAllowlist: [],
          pollIntervalMs: 300_000, projects: [], failed: [],
        },
      },
    }),
  );
  await context.route("**/api/all/beads/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: "retry: 600000\n: connected\n\n",
    }),
  );
}

async function eventually(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${step}: ${label}${last ? ` (${last.message})` : ""}`);
}

const searchBox = () => page.locator('input[data-notes-search]');
const tagBox = () => page.locator('input[data-notes-tag]');
const folderBox = () => page.locator('input[data-notes-folder]');
const kindSelect = () => page.locator('select[data-notes-kind]');
const hits = () => page.locator('[data-testid="search-hit"]');
const paramsOf = () => new URL(page.url()).searchParams;

async function clearConfig() {
  await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesServiceUrl: null }),
  }).catch(() => {});
}

try {
  await clearConfig();

  // --- Title, shell, switcher, empty query ---
  step = "title and shell";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [], total: 0 }) }),
  );
  await page.goto(`${base}/search`);
  await page.getByRole("heading", { name: "Busca" }).waitFor();
  assert.equal(await page.title(), "Busca | Houston", "page title");
  const main = page.locator('main[aria-label="Busca"]');
  assert.equal(await main.count(), 1, "main has accessible name Busca");
  assert.equal(await main.getAttribute("lang"), "pt-BR", "main lang pt-BR");
  assert.equal(await page.locator("aside nav button").count(), 0, "no view buttons");
  const trigger = page.getByRole("button", { name: "Select project, current project Busca", exact: true });
  await trigger.waitFor();
  const triggerText = (await trigger.innerText()).replace(/\s+/g, " ");
  assert.match(triggerText, /Busca/, "switcher names Busca");
  assert.match(triggerText, /busca de notas/, "switcher second line");
  assert.equal(await trigger.locator("span.rounded-full").count(), 0, "no status dot");
  await page.getByText("Digite um termo para buscar nas notas.").waitFor();
  await context.close();

  // --- Typing runs one request after a pause ---
  step = "typing debounces to one request";
  await newContext();
  await installBase({ notes: true });
  const typed = { requests: [] };
  await context.route("**/api/notes/search*", (route) => {
    const url = new URL(route.request().url());
    typed.requests.push(url.searchParams.get("q"));
    return route.fulfill({ json: answer({ hits: [hit("n1")], total: 1 }) });
  });
  await page.goto(`${base}/search`);
  await searchBox().waitFor();
  await searchBox().click();
  for (const ch of "rollout") {
    await page.keyboard.press(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await hits().first().waitFor();
  await eventually(async () => typed.requests.length >= 1, "one search request");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(typed.requests.length, 1, `typing sends one request, saw ${JSON.stringify(typed.requests)}`);
  assert.equal(typed.requests[0], "rollout", "the request carries the full query");
  assert.equal(paramsOf().get("q"), "rollout", "the query reaches the URL");
  assert.match(await hits().first().innerText(), /Title of n1/, "the hit title shows");
  await context.close();

  // --- Filters and paging reach the request and the URL; reload keeps them ---
  step = "filters and paging";
  await newContext();
  await installBase({ notes: true });
  const seen = { requests: [] };
  await context.route("**/api/notes/search*", (route) => {
    const url = new URL(route.request().url());
    seen.requests.push(Object.fromEntries(url.searchParams));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const total = 41;
    return route.fulfill({
      json: answer({ hits: [hit("n1"), hit("n2")], total, limit: 20, offset }),
    });
  });
  await page.goto(`${base}/search?q=rollout`);
  await hits().first().waitFor();
  await tagBox().fill("ops");
  await folderBox().fill("ops/2026_q4");
  await kindSelect().selectOption("evidencia");
  await eventually(async () => seen.requests.some((r) => r.tag === "ops" && r.folder === "ops/2026_q4" && r.kind === "evidencia"), "filters reach the request");
  const last = seen.requests[seen.requests.length - 1];
  assert.equal(last.q, "rollout");
  assert.equal(paramsOf().get("tag"), "ops", "tag reaches the URL");
  assert.equal(paramsOf().get("folder"), "ops/2026_q4", "folder reaches the URL");
  assert.equal(paramsOf().get("kind"), "evidencia", "kind reaches the URL");
  assert.equal(paramsOf().get("offset"), null, "a filter change keeps offset unset");
  await page.getByRole("button", { name: "Próxima", exact: true }).click();
  await eventually(async () => paramsOf().get("offset") === "20", "paging reaches the URL");
  await eventually(async () => seen.requests.some((r) => r.offset === "20"), "paging reaches the request");
  const urlBefore = page.url();
  await page.reload();
  await hits().first().waitFor();
  assert.equal(page.url(), urlBefore, "reload keeps the address");
  assert.equal(await searchBox().inputValue(), "rollout", "reload keeps the query");
  assert.equal(await tagBox().inputValue(), "ops", "reload keeps the tag");
  assert.equal(await folderBox().inputValue(), "ops/2026_q4", "reload keeps the folder");
  assert.equal(await kindSelect().inputValue(), "evidencia", "reload keeps the kind");
  assert.equal(paramsOf().get("offset"), "20", "reload keeps the offset");
  // Changing a filter on the second page asks for offset 0.
  const countBefore = seen.requests.length;
  await tagBox().fill("other");
  await eventually(async () => seen.requests.length > countBefore, "a filter change refetches");
  const after = seen.requests[seen.requests.length - 1];
  assert.equal(after.offset, undefined, `a filter change drops offset, saw ${JSON.stringify(after)}`);
  assert.equal(paramsOf().get("offset"), null, "a filter change drops offset from the URL");
  await context.close();

  // --- A slow first answer does not replace a later one ---
  step = "slow first answer loses";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "slow1") {
      return new Promise((resolve) => setTimeout(() => {
        route.fulfill({ json: answer({ hits: [hit("s1", { title: "first result", word: "slow1" })], total: 1 }) }).then(resolve).catch(resolve);
      }, 1000));
    }
    return route.fulfill({ json: answer({ hits: [hit("s2", { title: "second result", word: "slow2" })], total: 1 }) });
  });
  await page.goto(`${base}/search`);
  await searchBox().waitFor();
  await searchBox().fill("slow1");
  await new Promise((r) => setTimeout(r, 600));
  await searchBox().fill("slow2");
  await page.getByText("second result").waitFor();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await page.getByText("second result").count(), 1, "the later answer stays");
  assert.equal(await page.getByText("first result").count(), 0, "the slow first answer never overwrites it");
  await context.close();

  // --- Snippet markers become marks, never HTML ---
  step = "snippet marks and script text";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({
      json: answer({
        hits: [
          hit("n1", { title: "Script note", snippet: `before ${STX}<script>alert(1)</script>${ETX} after` }),
          hit("n2", { title: "Kind note", kind: "plano", tags: ["a", "b"], snippet: `the ${STX}rollout${ETX} plan` }),
        ],
        total: 2,
      }),
    }),
  );
  await page.goto(`${base}/search?q=rollout`);
  await hits().first().waitFor();
  assert.equal(await hits().count(), 2, "two hits");
  const firstText = await hits().nth(0).innerText();
  assert.match(firstText, /Script note/, "title shows");
  assert.match(firstText, /Kind note|Script note/, "titles show");
  assert.equal(await page.locator('[data-testid="search-hit"] mark').count(), 2, "two marks, one per snippet");
  assert.equal(await page.locator('[data-testid="search-hit"] mark').nth(0).innerText(), "<script>alert(1)</script>", "the script is mark text");
  assert.equal(await page.locator('main[aria-label="Busca"] script').count(), 0, "no script element inside the results");
  const second = await hits().nth(1).innerText();
  assert.match(second, /plano/, "kind shows");
  assert.match(second, /work\/n2\.md/, "path shows");
  assert.match(second, /\ba\b/, "tags show");
  await context.close();

  // --- Shortcut: from project page and /all, focus on /search, suppressed cases ---
  step = "shortcut opens from project and all";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [], total: 0 }) }),
  );
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  await page.getByRole("link", { name: "Busca", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.press("Control+Shift+F");
  await page.waitForURL((url) => url.pathname === "/search");
  await page.goto(`${base}/all`);
  await page.locator("aside nav").first().waitFor();
  await page.getByRole("link", { name: "Busca", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.press("Control+Shift+F");
  await page.waitForURL((url) => url.pathname === "/search");
  await context.close();

  step = "shortcut focuses on search without changing the URL";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [], total: 0 }) }),
  );
  await page.goto(`${base}/search?q=rollout&tag=ops`);
  await searchBox().waitFor();
  await page.getByRole("link", { name: "Busca", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 500));
  await page.locator("main[aria-label='Busca'] h1").click();
  const before = page.url();
  await page.keyboard.press("Control+Shift+F");
  await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-notes-search") !== null)), "the query box is focused");
  assert.equal(page.url(), before, "the URL does not change");
  // While typing in the query box the shortcut must not navigate away.
  await searchBox().click();
  await page.keyboard.press("Control+Shift+F");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(page.url(), before, "no navigation while typing in the query box");
  await context.close();

  step = "shortcut suppressed while typing, dialog open, or notes false";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [], total: 0 }) }),
  );
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  await page.getByRole("link", { name: "Busca", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 500));
  // The project page has its own search box; typing there must suppress the shortcut.
  const projectBox = page.locator("input[data-search]");
  if ((await projectBox.count()) > 0) {
    await projectBox.first().click();
    await page.keyboard.press("Control+Shift+F");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(new URL(page.url()).pathname, "/p/demo", "no navigation while typing in an input");
    await page.locator("main").first().click();
  }
  const help = page.getByRole("dialog", { name: /keyboard shortcuts/i });
  await eventually(async () => {
    if ((await help.count()) > 0) return true;
    await page.keyboard.press("?");
    await new Promise((r) => setTimeout(r, 400));
    return (await help.count()) > 0;
  }, "help dialog opens");
  assert.ok((await help.getByText("Search notes", { exact: true }).count()) >= 1, "help lists Search notes when configured");
  const searchRow = help.locator("div.min-h-9").filter({ hasText: "Search notes" });
  assert.equal(await searchRow.count(), 1, "one Search notes row in the help dialog");
  for (const key of ["⌘/Ctrl", "Shift", "F"]) {
    assert.ok((await searchRow.getByText(key, { exact: true }).count()) >= 1, `the row shows ${key}`);
  }
  await page.keyboard.press("Control+Shift+F");
  assert.equal(new URL(page.url()).pathname, "/p/demo", "no navigation while a dialog is open");
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await context.close();

  await newContext();
  await installBase({ notes: false });
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.press("Control+Shift+F");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(new URL(page.url()).pathname, "/p/demo", "no navigation when notes is false");
  await context.close();

  // --- kind=bogus answers 400 from the real proxy, as do a bad limit and offset ---
  step = "invalid kind from the proxy";
  await newContext();
  await installBase({ notes: true });
  await page.goto(`${base}/search?q=rollout&kind=bogus`);
  await page.getByText("Busca inválida.").waitFor();
  assert.equal(await page.getByText("O serviço de notas não está disponível.").count(), 0, "an invalid search is not an unavailable service");
  const invalidKind = await page.evaluate(async () => {
    const res = await fetch("/api/notes/search?q=rollout&kind=bogus");
    return { status: res.status, cache: res.headers.get("cache-control") };
  });
  assert.equal(invalidKind.status, 400, "the proxy answers 400 for kind=bogus");
  assert.equal(invalidKind.cache, "no-store", "the proxy answers no-store");
  for (const [label, query] of [
    ["empty q", "q="],
    ["bad limit", "q=rollout&limit=0"],
    ["limit text", "q=rollout&limit=x"],
    ["negative offset", "q=rollout&offset=-1"],
    ["offset text", "q=rollout&offset=x"],
  ]) {
    const answer = await page.evaluate(async (search) => {
      const res = await fetch(`/api/notes/search?${search}`);
      return { status: res.status, cache: res.headers.get("cache-control") };
    }, query);
    assert.equal(answer.status, 400, `the proxy answers 400 for ${label}`);
    assert.equal(answer.cache, "no-store", `the 400 for ${label} carries no-store`);
  }
  await context.close();

  // --- Link, card and shortcut entries hidden without the service ---
  step = "hidden without notes";
  await newContext();
  await installBase({ notes: false });
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  await eventually(async () => {
    const caps = await page.evaluate(async () => {
      const res = await fetch("/api/capabilities");
      return res.json();
    });
    return caps.notes === false;
  }, "capabilities answered without notes");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.getByRole("link", { name: "Busca", exact: true }).count(), 0, "no sidebar Busca link");
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.getByRole("button", { name: /^Busca/ }).count(), 0, "no launcher Busca card");
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  const helpHidden = page.getByRole("dialog", { name: /keyboard shortcuts/i });
  await eventually(async () => {
    if ((await helpHidden.count()) > 0) return true;
    await page.keyboard.press("?");
    await new Promise((r) => setTimeout(r, 400));
    return (await helpHidden.count()) > 0;
  }, "help dialog opens");
  assert.equal(await helpHidden.getByText("Search notes", { exact: true }).count(), 0, "help hides Search notes");
  await page.keyboard.press("Escape");
  await page.goto(`${base}/p/demo?view=settings`);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.getByText("Search notes", { exact: true }).count(), 0, "settings hides Search notes");
  await context.close();

  // --- Shown with the service ---
  step = "shown with notes";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [], total: 0 }) }),
  );
  await page.goto(`${base}/p/demo`);
  await page.locator("aside nav").first().waitFor();
  await page.getByRole("link", { name: "Busca", exact: true }).waitFor();
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Busca/ }).waitFor();
  const cardText = await page.getByRole("button", { name: /^Busca/ }).innerText();
  assert.match(cardText, /busca de notas/, "card second line");
  await page.goto(`${base}/p/demo?view=settings`);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByText("Search notes", { exact: true }).first().waitFor();
  await context.close();

  // --- Unconfigured state ---
  step = "unconfigured state";
  await newContext();
  await installBase({ notes: false });
  await page.goto(`${base}/search`);
  await page.getByText("A busca de notas não está configurada.").waitFor();
  assert.match(await page.locator("body").innerText(), /notesServiceUrl/, "names the key");
  await context.close();

  // --- Unavailable state through the real proxy ---
  step = "unavailable state";
  await clearConfig();
  const put = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesServiceUrl: "http://127.0.0.1:9/" }),
  });
  assert.equal(put.status, 200, "notes url set");
  try {
    const fresh = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    page = await fresh.newPage();
    page.setDefaultTimeout(10_000);
    context = fresh;
    await page.goto(`${base}/search?q=rollout`);
    await page.getByText("O serviço de notas não está disponível.").waitFor();
    await context.close();
    context = null;
  } finally {
    await clearConfig();
  }

  // --- Obsidian link with encoding and no target ---
  step = "obsidian link with encoding and no target";
  await newContext();
  await installBase({ notes: true, vault: OBS_VAULT });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [hit("n1", { title: "Special note", path: OBS_PATH })], total: 1 }) }),
  );
  await page.goto(`${base}/search?q=rollout`);
  await hits().first().waitFor();
  const searchAnchor = hits().first().locator("a");
  assert.equal(await searchAnchor.count(), 1, "one obsidian anchor in the hit");
  assert.equal(await searchAnchor.innerText(), OBS_PATH, "anchor text is the path");
  const searchHref = await searchAnchor.getAttribute("href");
  assert.equal(searchHref, OBS_HREF, "vault and file encoded with encodeURIComponent");
  assert.equal(await searchAnchor.getAttribute("target"), null, "no target on the obsidian link");
  const decodedSearch = decodeObsidian(searchHref);
  assert.equal(decodedSearch.vault, OBS_VAULT, "vault decodes back");
  assert.equal(decodedSearch.file, OBS_PATH, "path with spaces, accents, #, & and + decodes back");
  await context.close();

  // --- Plain path without the vault, and with an empty path ---
  step = "plain path without vault and with empty path";
  await newContext();
  await installBase({ notes: true });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({
      json: answer({
        hits: [
          hit("n1", { title: "Special note", path: OBS_PATH }),
          hit("n2", { title: "Empty path note", path: "" }),
        ],
        total: 2,
      }),
    }),
  );
  await page.goto(`${base}/search?q=rollout`);
  await hits().first().waitFor();
  assert.equal(await hits().count(), 2, "two hits");
  assert.equal(await hits().first().locator("a").count(), 0, "no anchor without the vault");
  assert.match(await hits().first().innerText(), /Café com espaço/, "plain path shows");
  assert.equal(await hits().nth(1).locator("a").count(), 0, "no anchor for an empty path");
  await context.close();

  await newContext();
  await installBase({ notes: true, vault: OBS_VAULT });
  await context.route("**/api/notes/search*", (route) =>
    route.fulfill({ json: answer({ hits: [hit("n9", { title: "Empty path note", path: "" })], total: 1 }) }),
  );
  await page.goto(`${base}/search?q=rollout`);
  await hits().first().waitFor();
  assert.equal(await hits().first().locator("a").count(), 0, "no anchor for an empty path even with the vault");
  await context.close();

  console.log("PASS search page: typing, filters, paging, reload, offset reset, slow answer, shortcut, invalid, hidden, unconfigured, unavailable, snippet, obsidian");
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await clearConfig();
  try {
    await context?.close();
  } catch {}
  try {
    await browser.close();
  } catch {}
}
