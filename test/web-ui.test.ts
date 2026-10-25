/**
 * Browser smoke test: evaluates the real dashboard assets in jsdom against the
 * real aggregation output, so a typo in app.js or a missing element fails CI.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { aggregate, sessionDetail } from "../src/aggregate.ts";
import { clearScanCache, scanSessions } from "../src/scanner.ts";
import { createFixture, type Fixture } from "./fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, "..", "src", "web", "static");

let fixture: Fixture;
let stats: ReturnType<typeof aggregate>;
let detail: ReturnType<typeof sessionDetail>;
let dom: JSDOM;
let fetchCalls: URL[];

function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  fixture = createFixture();
  clearScanCache();
  const scan = await scanSessions({ dirs: [fixture.root] });
  stats = aggregate(scan, {}, Date.parse("2026-03-05T00:00:00.000Z"));
  detail = sessionDetail(scan, "s-alpha");

  const html = readFileSync(path.join(STATIC, "index.html"), "utf8")
    .replaceAll("__TOKEN__", "secret-token")
    .replaceAll("__DIRS__", fixture.root)
    .replaceAll("__VERSION__", "test");

  dom = new JSDOM(html, { url: "http://127.0.0.1:4789/?token=secret-token", runScripts: "outside-only" });
  const { window } = dom;
  fetchCalls = [];

  window.fetch = (async (input: string | { url: string }) => {
    const raw = typeof input === "string" ? input : String(input);
    const url = new URL(raw, "http://127.0.0.1:4789");
    fetchCalls.push(url);
    const payload = url.pathname === "/api/session" ? detail : stats;
    if (url.pathname === "/api/session" && !detail) {
      return { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "not found" };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as never;

  class FakeEventSource {
    url: string;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {
      /* live updates are not exercised here */
    }
    close(): void {}
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  (window as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
    setTimeout(cb, 0);
    return 0;
  };

  window.eval(readFileSync(path.join(STATIC, "theme.js"), "utf8"));
  window.eval(readFileSync(path.join(STATIC, "app.js"), "utf8"));
  await tick(60);
});

after(() => {
  dom?.window.close();
  clearScanCache();
  fixture?.cleanup();
});

function text(selector: string): string {
  return dom.window.document.querySelector(selector)?.textContent?.trim() ?? "";
}

function click(selector: string): void {
  const node = dom.window.document.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("web dashboard", () => {
  it("requests stats with the embedded token", () => {
    assert.ok(fetchCalls.length > 0);
    const statsCall = fetchCalls.find((url) => url.pathname === "/api/stats");
    assert.ok(statsCall);
    assert.equal(statsCall.searchParams.get("token"), "secret-token");
  });

  it("renders KPIs from the aggregation", () => {
    assert.match(text("#kpiTokens"), /^8\.\d+k$/);
    assert.match(text("#kpiCost"), /^\$0\.85$/);
    assert.equal(text("#kpiSessions"), "2");
    assert.match(text("#kpiRequests"), /^6/);
    assert.match(text("#kpiCache"), /^5\d%$/);
    assert.ok(text("#kpiAvg").length > 0);
  });

  it("renders the chart, model rows and session rows", () => {
    assert.equal(dom.window.document.querySelectorAll("#chart svg g.bar-group").length, stats.byDay.length);
    const modelRows = dom.window.document.querySelectorAll("#modelTable tbody tr");
    assert.equal(modelRows.length, 2);
    assert.match(modelRows[0]!.textContent ?? "", /claude-x/);

    const sessionRows = dom.window.document.querySelectorAll("#sessionTable tbody tr");
    assert.equal(sessionRows.length, 2);
    assert.match(sessionRows[0]!.textContent ?? "", /Alpha work/);

    assert.equal(dom.window.document.querySelectorAll("#kindList .bar-row").length, stats.byKind.length);
    assert.ok(dom.window.document.querySelectorAll("#projectList .bar-row").length >= 2);
    assert.match(text("#dataMeta"), /Session files/);
  });

  it("switches theme and persists the choice", () => {
    click('[data-theme-choice="dark"]');
    assert.equal(dom.window.document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(dom.window.localStorage.getItem("pi-token-viewer-theme"), "dark");
    click('[data-theme-choice="light"]');
    assert.equal(dom.window.document.documentElement.getAttribute("data-theme"), "light");
  });

  it("toggles the metric without refetching", () => {
    const before = fetchCalls.length;
    click('[data-metric="cost"]');
    assert.ok(dom.window.document.querySelector('[data-metric="cost"]')?.classList.contains("active"));
    assert.equal(fetchCalls.length, before);
  });

  it("filters the session table as you type", () => {
    const search = dom.window.document.querySelector("#sessionSearch") as HTMLInputElement;
    search.value = "beta";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const rows = dom.window.document.querySelectorAll("#sessionTable tbody tr");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.textContent ?? "", /beta/i);

    search.value = "";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(dom.window.document.querySelectorAll("#sessionTable tbody tr").length, 2);
  });

  it("opens the session drawer with detail data", async () => {
    click("#sessionTable tbody tr");
    await tick(60);
    assert.equal(dom.window.document.querySelector("#sessionDrawer")?.getAttribute("aria-hidden"), "false");
    assert.equal(text("#drawerTitle"), "Alpha work");
    assert.match(text("#drawerBody"), /Total tokens/);
    assert.match(text("#drawerBody"), /claude-x/);

    click("#focusSession");
    await tick(40);
    assert.equal(dom.window.document.querySelector("#sessionDrawer")?.getAttribute("aria-hidden"), "true");
    const last = fetchCalls[fetchCalls.length - 1]!;
    assert.equal(last.searchParams.get("session"), "s-alpha");
    assert.equal(dom.window.document.querySelector("#clearSession")?.hasAttribute("hidden"), false);
  });

  it("filters by model chip and date range", async () => {
    const before = fetchCalls.length;
    click("#modelChips .chip");
    await tick(40);
    assert.ok(fetchCalls.length > before);
    assert.equal(fetchCalls[fetchCalls.length - 1]!.searchParams.get("models"), "anthropic/claude-x");

    click('#rangeGroup [data-range="7"]');
    await tick(40);
    assert.equal(fetchCalls[fetchCalls.length - 1]!.searchParams.get("range"), "7");
  });

  it("resets filters and shows shortcuts", async () => {
    click("#resetBtn");
    await tick(40);
    const reset = fetchCalls[fetchCalls.length - 1]!;
    assert.equal(reset.searchParams.get("models"), null);
    assert.equal(reset.searchParams.get("range"), null);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "?", bubbles: true }));
    assert.equal(dom.window.document.querySelector("#shortcuts")?.hasAttribute("hidden"), false);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(dom.window.document.querySelector("#shortcuts")?.hasAttribute("hidden"), true);
  });
});
