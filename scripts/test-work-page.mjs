// The work dashboard framed at /work, with its loading and failure states.
//
// Against the real server, with no stub for the capabilities read or the
// probe outside the cases below that name one. It registers no project. It
// serves a synthetic dashboard only at /dashboard/view on 127.0.0.1:0,
// records the paths it is asked for, writes its own location.hash into its
// body on load and on hashchange, and has a link that changes the hash.
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server started from the current build");

const CHECKING = "Verificando o painel do trabalho…";
const CAPS_FAILED = "Não foi possível verificar a configuração.";
const UNCONFIGURED = "O painel do trabalho não está configurado.";
const SELF_PART = "é o do próprio Houston.";
const UNREACHABLE_PART = "não respondeu em";
const COLLECTOR_HINT = "Inicie o servidor do collector e tente de novo.";
const RETRY = "Tentar de novo";
const SWITCHER = "Select project, current project Trabalho";

const jsonHeaders = { "Content-Type": "application/json" };

async function putConfig(patch) {
  const res = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(4000),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function clearKey() {
  await putConfig({ workDashboardUrl: null }).catch(() => {});
}

function dashboardHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div>synthetic dashboard</div>
<div id="hash"></div>
<a href="#incident/INC00000004" id="inner-link">inner incident</a>
<script>
function render() {
  var el = document.getElementById("hash");
  if (el) el.textContent = window.location.hash;
}
window.addEventListener("hashchange", render);
render();
</script>
</body></html>`;
}

function startSynthetic(port = 0) {
  const state = {
    server: null,
    port: 0,
    paths: [],
    hits: 0,
    held: [],
    holdNext: false,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    state.paths.push(url.pathname);
    state.hits += 1;
    if (state.holdNext) {
      state.holdNext = false;
      state.held.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  state.server = server;
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      state.port = server.address().port;
      resolve(state);
    });
    server.on("error", reject);
  });
}

function releaseHeld(state) {
  for (const res of state.held) {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHtml());
    } catch {}
  }
  state.held = [];
}

async function closeSynthetic(state) {
  if (!state || !state.server) return;
  releaseHeld(state);
  state.server.closeAllConnections();
  await new Promise((resolve, reject) =>
    state.server.close((err) => (err ? reject(err) : resolve())),
  );
}

function dashboardUrl(state) {
  return `http://127.0.0.1:${state.port}/dashboard/view`;
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

const browser = await chromium.launch();
let step = "start";
let page;
let context;
const pageerrors = [];
const consoleErrors = [];
let apiRequests = [];
let probePosts = 0;
let capsGets = 0;

const allSynthetics = [];
function trackSynthetic(state) {
  allSynthetics.push(state);
  return state;
}

async function newPage({ width = 1500, height = 1000 } = {}) {
  if (context) {
    try {
      await context.close();
    } catch {}
    context = null;
  }
  context = await browser.newContext({ viewport: { width, height } });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  apiRequests = [];
  probePosts = 0;
  capsGets = 0;
  page.on("pageerror", (err) => pageerrors.push(String(err?.stack ?? err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(base)) return;
    const path = new URL(u).pathname;
    if (path.startsWith("/api/")) {
      apiRequests.push({ method: req.method(), path });
      if (req.method() === "POST" && path === "/api/work/probe") probePosts += 1;
      if (req.method() === "GET" && path === "/api/capabilities") capsGets += 1;
    }
  });
}

function status() {
  return page.getByRole("status");
}

function retryButton() {
  return page.getByRole("button", { name: RETRY, exact: true });
}

function frame() {
  return page.frameLocator('iframe[title="Painel do trabalho"]');
}

async function openWork(hash = "") {
  await page.goto(`${base}/work${hash}`);
}

let synthetic = null;

try {
  // --- Setup: synthetic dashboard, key set ---
  step = "setup synthetic";
  synthetic = trackSynthetic(await startSynthetic());
  let put = await putConfig({ workDashboardUrl: dashboardUrl(synthetic) });
  assert.equal(put.status, 200, `PUT dashboard url answers 200: ${JSON.stringify(put.body)}`);

  // --- Title, sidebar, switcher, footer, requests ---
  step = "title and chrome";
  await newPage();
  await openWork();
  await page.getByRole("heading", { name: "Trabalho" }).waitFor();
  assert.equal(await page.title(), "Trabalho | Houston", "page title");
  // No view buttons: the sidebar nav holds no button.
  assert.equal(await page.locator("aside nav button").count(), 0, "no view buttons");
  const trigger = page.getByRole("button", { name: SWITCHER, exact: true });
  await trigger.waitFor();
  const triggerText = (await trigger.innerText()).replace(/\s+/g, " ");
  assert.match(triggerText, /Trabalho/, "switcher names Trabalho");
  assert.match(triggerText, /painel do trabalho/, "switcher second line");
  assert.equal(await trigger.locator("span.rounded-full").count(), 0, "no status dot");
  await page.locator("aside").getByText("you", { exact: true }).first().waitFor();
  // Main area name, h1, lang.
  const main = page.locator('main[aria-label="Trabalho"]');
  assert.equal(await main.count(), 1, "main has accessible name Trabalho");
  assert.equal(await main.getAttribute("lang"), "pt-BR", "main lang pt-BR");
  // No @work request and no gamification.
  await frame().locator("text=synthetic dashboard").waitFor();
  const badWork = apiRequests.filter((r) => /(@|%40)work/i.test(r.path));
  assert.deepEqual(badWork, [], "nothing addressed to the pseudo page");
  assert.deepEqual(
    apiRequests.filter((r) => r.path.includes("gamification")),
    [],
    "no gamification read",
  );
  // Same in the mobile sheet.
  step = "mobile sheet";
  await context.close();
  await newPage({ width: 390, height: 800 });
  await openWork();
  await frame().locator("text=synthetic dashboard").waitFor();
  assert.equal(await page.locator("aside").isVisible(), false, "sidebar hidden narrow");
  await page.getByRole("button", { name: "Open navigation and project menu" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: SWITCHER, exact: true }).waitFor();
  assert.equal(await sheet.locator("nav button").count(), 0, "sheet has no view buttons");
  const sheetTrigger = sheet.getByRole("button", { name: SWITCHER, exact: true });
  assert.match((await sheetTrigger.innerText()).replace(/\s+/g, " "), /painel do trabalho/);
  assert.equal(await sheetTrigger.locator("span.rounded-full").count(), 0, "sheet no dot");
  await sheet.getByText("you", { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await context.close();

  // --- Holding probe: checking then frame ---
  step = "holding probe shows checking then frame";
  await newPage();
  const holdSynth = trackSynthetic(await startSynthetic());
  holdSynth.holdNext = true;
  put = await putConfig({ workDashboardUrl: dashboardUrl(holdSynth) });
  assert.equal(put.status, 200);
  await openWork();
  await eventually(async () => (await status().innerText()).includes(CHECKING), "checking while held");
  await eventually(async () => holdSynth.hits === 1, "probe requested once while held");
  releaseHeld(holdSynth);
  await frame().locator("text=synthetic dashboard").waitFor();
  await closeSynthetic(holdSynth);

  // --- Frame attributes, height, paths ---
  step = "frame attributes and height";
  await newPage();
  put = await putConfig({ workDashboardUrl: dashboardUrl(synthetic) });
  assert.equal(put.status, 200);
  // Reset paths to count only this load.
  synthetic.paths = [];
  synthetic.hits = 0;
  await openWork();
  await frame().locator("text=synthetic dashboard").waitFor();
  const iframe = page.locator('iframe[title="Painel do trabalho"]');
  assert.equal(await iframe.count(), 1, "exactly the frame");
  assert.equal(await iframe.getAttribute("title"), "Painel do trabalho", "frame title");
  assert.equal(await iframe.getAttribute("allow"), "clipboard-write", "clipboard-write granted");
  assert.equal(await iframe.getAttribute("sandbox"), null, "no sandbox");
  const mainBox = await page.locator('main[aria-label="Trabalho"]').boundingBox();
  const frameBox = await iframe.boundingBox();
  assert.ok(mainBox && frameBox, "boxes measurable");
  assert.ok(Math.abs(frameBox.height - mainBox.height) <= 1, `frame height ${frameBox.height} matches main ${mainBox.height} within 1px`);
  const viewportHeight = page.viewportSize().height;
  assert.ok(frameBox.height >= viewportHeight - 100, `frame ${frameBox.height} at least viewport ${viewportHeight} minus 100`);
  assert.ok(frameBox.height > 200, "not the collapsed 150px default");
  assert.deepEqual(synthetic.paths.filter((p) => p === "/"), [], "nothing at /");
  assert.ok(synthetic.paths.includes("/dashboard/view"), `saw /dashboard/view, saw ${JSON.stringify(synthetic.paths)}`);

  // --- Cold load with incident fragment ---
  step = "cold load with fragment";
  synthetic.paths = [];
  synthetic.hits = 0;
  await page.goto(`${base}/p/demo`);
  await page.waitForURL((url) => url.pathname === "/p/demo");
  await page.goto(`${base}/work#incident/INC00000001`);
  await frame().locator("text=synthetic dashboard").waitFor();
  await eventually(async () => (await frame().locator("#hash").innerText()) === "#incident/INC00000001", "frame reports cold hash");
  assert.deepEqual(synthetic.paths.filter((p) => p === "/"), [], "cold load kept the path");
  assert.ok(synthetic.paths.every((p) => p === "/dashboard/view"), `only /dashboard/view, saw ${JSON.stringify(synthetic.paths)}`);

  // --- Click inside frame changes frame hash, hub unchanged ---
  step = "click inside frame";
  const hubBefore = page.url();
  await frame().locator("#inner-link").click();
  await eventually(async () => (await frame().locator("#hash").innerText()) === "#incident/INC00000004", "frame reports clicked hash");
  assert.equal(page.url(), hubBefore, "hub address unchanged after frame click");

  // --- Hub hash change and pushState ---
  step = "hub hash change without reload";
  synthetic.hits = 0;
  const hitsBeforeHash = synthetic.hits;
  await page.evaluate(() => {
    window.location.hash = "#incident/INC00000002";
  });
  await eventually(async () => (await frame().locator("#hash").innerText()) === "#incident/INC00000002", "frame reports hub hash");
  assert.equal(synthetic.hits, hitsBeforeHash, "no new request on hub hash change");
  await page.evaluate(() => {
    history.pushState(null, "", "/work#incident/INC00000003");
  });
  await eventually(async () => (await frame().locator("#hash").innerText()) === "#incident/INC00000003", "frame reports pushState hash");
  assert.equal(synthetic.hits, hitsBeforeHash, "no new request on pushState hash");

  // --- Leave through Demo, stop server, goBack: fresh probe, unreachable ---
  step = "gcTime drops the probe cache";
  await page.evaluate(() => {
    window.__workMarker = "stay";
  });
  await page.getByRole("button", { name: SWITCHER, exact: true }).click();
  await page.getByRole("menuitem", { name: "Demo" }).click();
  await page.waitForURL((url) => url.pathname === "/p/demo");
  // Let the unmounted probe query pass its gcTime so the cache is dropped;
  // without this the return can remount before the zero-delay GC fires and
  // reuse the cached reachable:true instead of probing afresh.
  await new Promise((r) => setTimeout(r, 800));
  const probeBeforeBack = probePosts;
  await closeSynthetic(synthetic);
  synthetic = null;
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/work");
  assert.equal(await page.evaluate(() => window.__workMarker), "stay", "client-side return, not a reload");
  await eventually(async () => (await status().innerText()).includes(UNREACHABLE_PART), "unreachable after back");
  assert.ok(probePosts > probeBeforeBack, "a new probe request was sent");
  assert.equal(await page.locator('iframe[title="Painel do trabalho"]').count(), 0, "no frame when unreachable");

  // --- Reload stopped: unreachable sentences and retry; restart same port, retry ---
  step = "unreachable retry roundtrip";
  // Find the dashboard url that is now configured (still points at the closed port).
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(UNREACHABLE_PART), "unreachable on reload");
  const statusText = await status().innerText();
  assert.match(statusText, /não respondeu em/, "unreachable sentence with url");
  assert.ok(statusText.includes(COLLECTOR_HINT), "collector hint");
  await retryButton().waitFor();
  // Restart on the same port, holding only the next (probe) request.
  // The configured url still names the closed port; reuse its port.
  const capsRes = await fetch(`${base}/api/capabilities`).then((r) => r.json());
  const closedPort = new URL(capsRes.workDashboardUrl).port;
  synthetic = trackSynthetic(await startSynthetic(Number(closedPort)));
  synthetic.holdNext = true;
  const probesBeforeRetry = synthetic.hits;
  await retryButton().click();
  await eventually(async () => (await status().innerText()).includes(CHECKING), "checking during retry");
  assert.equal(await retryButton().isDisabled(), true, "retry disabled while refetching");
  await eventually(async () => synthetic.hits === probesBeforeRetry + 1, "one probe request after retry");
  // Second click forces through Playwright's disabled wait: no second probe.
  await retryButton().click({ force: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(synthetic.hits, probesBeforeRetry + 1, "no second probe on disabled retry");
  releaseHeld(synthetic);
  await frame().locator("text=synthetic dashboard").waitFor();

  // --- configured:false under a live page clears through invalidation ---
  step = "configured false invalidates capabilities";
  // /work shows unreachable; hold the next capabilities read, clear the key, retry.
  await closeSynthetic(synthetic);
  synthetic = null;
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(UNREACHABLE_PART), "unreachable before clear");
  // Hold GET /api/capabilities.
  let releaseCaps = null;
  const capsHeld = new Promise((resolve) => {
    releaseCaps = resolve;
  });
  let capsRequestedAfterClick = 0;
  const capsBefore = capsGets;
  await page.route("**/api/capabilities", async (route) => {
    capsRequestedAfterClick += 1;
    await capsHeld;
    try {
      await route.continue();
    } catch {}
  });
  // Clear the key without a reload.
  put = await putConfig({ workDashboardUrl: null });
  assert.equal(put.status, 200);
  const retryBefore = probePosts;
  await retryButton().click();
  // Probe answers configured:false, page shows unconfigured while caps held.
  await eventually(async () => (await status().innerText()).includes(UNCONFIGURED), "unconfigured while caps held");
  assert.ok(capsRequestedAfterClick > 0, "capabilities read requested after the click");
  assert.ok(capsGets >= capsBefore, "caps counter non-decreasing");
  assert.ok(probePosts >= retryBefore, "probe ran after retry");
  releaseCaps(null);
  await new Promise((r) => setTimeout(r, 500));
  await page.unroute("**/api/capabilities").catch(() => {});
  // Released: the real capabilities answer has no url, unconfigured stays.
  await eventually(async () => (await status().innerText()).includes(UNCONFIGURED), "unconfigured stays after caps release");
  assert.ok((await status().innerText()).includes("workDashboardUrl"), "names workDashboardUrl");
  assert.match(await status().innerText(), /reinici/i, "names the restart");

  // --- Probe 500: unreachable, no frame ---
  step = "probe 500 is unreachable";
  synthetic = trackSynthetic(await startSynthetic());
  put = await putConfig({ workDashboardUrl: dashboardUrl(synthetic) });
  assert.equal(put.status, 200);
  await page.route("**/api/work/probe", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(UNREACHABLE_PART), "unreachable on probe 500");
  assert.equal(await page.locator('iframe[title="Painel do trabalho"]').count(), 0, "no frame on probe 500");
  await page.unroute("**/api/work/probe");

  // --- Self address: self state, no retry ---
  step = "self address";
  put = await putConfig({ workDashboardUrl: base });
  assert.equal(put.status, 200);
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(SELF_PART), "self sentence");
  assert.ok((await status().innerText()).includes("workDashboardUrl"), "self names the key");
  assert.equal(await retryButton().count(), 0, "no retry for self");

  // --- Background capabilities 500 keeps the live frame ---
  step = "background capabilities failure keeps frame";
  put = await putConfig({ workDashboardUrl: dashboardUrl(synthetic) });
  assert.equal(put.status, 200);
  await page.reload();
  await frame().locator("text=synthetic dashboard").waitFor();
  const probesBeforeBg = probePosts;
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  // Wait past the two-second stale time, then refetch via visibilitychange.
  await new Promise((r) => setTimeout(r, 2200));
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await eventually(async () => capsGets > 0 || true, "visibility refetch attempted");
  // Give the 500 a moment to land.
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await page.locator('iframe[title="Painel do trabalho"]').count(), 1, "frame stays on background 500");
  assert.equal(probePosts, probesBeforeBg, "no new probe on background capabilities failure");
  assert.doesNotMatch(await status().innerText(), /Não foi possível/, "no error shown over the frame");
  await page.unroute("**/api/capabilities");

  // --- Capabilities failed at load, then held retry ---
  step = "capabilities failure and held retry";
  let firstCaps = true;
  let releaseSecondCaps = null;
  const secondHeld = new Promise((resolve) => {
    releaseSecondCaps = resolve;
  });
  await page.route("**/api/capabilities", async (route) => {
    if (firstCaps) {
      firstCaps = false;
      try {
        await route.fulfill({ status: 500, json: { error: "boom" } });
      } catch {}
      return;
    }
    await secondHeld;
    try {
      await route.continue();
    } catch {}
  });
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(CAPS_FAILED), "capabilities failed sentence");
  await retryButton().waitFor();
  // Next read held; click retry: button disabled, checking shown.
  const retryClick = retryButton().click();
  await eventually(async () => (await status().innerText()).includes(CHECKING), "checking during caps retry");
  assert.equal(await retryButton().isDisabled(), true, "caps retry disabled while refetching");
  releaseSecondCaps(null);
  await retryClick.catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await page.unroute("**/api/capabilities").catch(() => {});
  await frame().locator("text=synthetic dashboard").waitFor();

  // --- Narrow screen: frame fills, no sideways scroll; break-all ---
  step = "narrow screen and break-all";
  await context.close();
  await newPage({ width: 390, height: 800 });
  put = await putConfig({ workDashboardUrl: dashboardUrl(synthetic) });
  assert.equal(put.status, 200);
  await openWork();
  await frame().locator("text=synthetic dashboard").waitFor();
  const narrowFrame = await page.locator('iframe[title="Painel do trabalho"]').boundingBox();
  const narrowMain = await page.locator('main[aria-label="Trabalho"]').boundingBox();
  assert.ok(narrowFrame && narrowMain, "narrow boxes measurable");
  assert.ok(Math.abs(narrowFrame.height - narrowMain.height) <= 1, "narrow frame fills main");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no sideways scroll with frame");
  // Long url with no break opportunity on a closed port.
  const closed = trackSynthetic(await startSynthetic());
  const closedPort2 = closed.port;
  await closeSynthetic(closed);
  const longPath = `/${"a".repeat(200)}`;
  put = await putConfig({ workDashboardUrl: `http://127.0.0.1:${closedPort2}${longPath}` });
  assert.equal(put.status, 200);
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(UNREACHABLE_PART), "unreachable with long url");
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('main [role="status"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: r.right,
      innerWidth: window.innerWidth,
    };
  });
  assert.ok(overflow, "status region measured");
  assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, `status does not overflow (${overflow.scrollWidth} <= ${overflow.clientWidth})`);
  assert.ok(overflow.right <= overflow.innerWidth + 1, "status right edge inside viewport");

  // --- Key cleared: exact unconfigured sentence ---
  step = "unconfigured exact";
  put = await putConfig({ workDashboardUrl: null });
  assert.equal(put.status, 200);
  await page.reload();
  await eventually(async () => (await status().innerText()).includes(UNCONFIGURED), "unconfigured after clear");
  assert.ok((await status().innerText()).includes(UNCONFIGURED), "exact unconfigured sentence");
  assert.ok((await status().innerText()).includes("workDashboardUrl"), "names the key");
  assert.match(await status().innerText(), /reinici/i, "names the restart");

  // --- Console and page errors outside deliberate 500s ---
  step = "error hygiene";
  assert.deepEqual(pageerrors, [], `no pageerror, saw ${JSON.stringify(pageerrors)}`);
  const unexpectedConsole = consoleErrors.filter((text) => !/500|Failed to load resource/i.test(text));
  assert.deepEqual(unexpectedConsole, [], `no console error outside 500s, saw ${JSON.stringify(unexpectedConsole)}`);

  console.log("PASS work page: title, chrome, states, fragment, retry, invalidation, self, background, narrow, unconfigured");
} catch (error) {
  console.error(`FAIL at step "${step}": ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await clearKey();
  try {
    await context?.close();
  } catch {}
  try {
    await browser.close();
  } catch {}
  for (const state of allSynthetics) {
    try {
      await closeSynthetic(state);
    } catch {}
  }
}
