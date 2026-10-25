import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { aggregate, applyFilterInput, sessionDetail } from "../src/aggregate.ts";
import { dailyToCsv, eventsToCsv, sessionsToCsv } from "../src/export.ts";
import { bar, formatCost, formatTokens, sparkline, stackedBar } from "../src/format.ts";
import { clearScanCache, localDay, parseTimestamp, scanSessions } from "../src/scanner.ts";
import type { ScanResult } from "../src/types.ts";
import { createFixture, type Fixture } from "./fixture.ts";

let fixture: Fixture;

before(() => {
  fixture = createFixture();
});

after(() => {
  clearScanCache();
  fixture?.cleanup();
});

async function scan(): Promise<ScanResult> {
  clearScanCache();
  return scanSessions({ dirs: [fixture.root] });
}

describe("scanner", () => {
  it("extracts one event per usage record and reports malformed lines", async () => {
    const result = await scan();
    assert.equal(result.sessions.length, 3);
    assert.equal(result.events.length, 6);
    assert.equal(result.scannedFiles, 3);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!.message, /invalid JSON/);
  });

  it("sums usage exactly, including cache warming, compaction and tool sub-calls", async () => {
    const result = await scan();
    const alpha = result.sessions.find((session) => session.id === "s-alpha");
    assert.ok(alpha);
    assert.equal(alpha.name, "Alpha work");
    assert.equal(alpha.messageCount, 4);
    assert.equal(alpha.userMessages, 1);
    assert.equal(alpha.assistantMessages, 2);
    assert.equal(alpha.toolCalls, 1);
    assert.equal(alpha.usage.input, 3110);
    assert.equal(alpha.usage.output, 555);
    assert.equal(alpha.usage.cacheRead, 4500);
    assert.equal(alpha.usage.cacheWrite, 100);
    assert.equal(alpha.usage.reasoning, 50);
    assert.equal(alpha.usage.totalTokens, 8265);
    assert.equal(Math.round(alpha.usage.cost.total * 1000) / 1000, 0.801);
    assert.deepEqual(alpha.models, ["anthropic/claude-x", "openai/gpt-y"]);
    assert.deepEqual(alpha.providers, ["anthropic", "openai"]);
  });

  it("keeps header-only sessions and derives stable fallback names", async () => {
    const result = await scan();
    const empty = result.sessions.find((session) => session.id === "s-empty");
    assert.ok(empty);
    assert.equal(empty.usage.totalTokens, 0);
    assert.equal(empty.project, "/work/empty");
    assert.match(empty.name, /empty/);
  });

  it("classifies usage kinds", async () => {
    const result = await scan();
    const kinds = new Map(result.events.map((event) => [event.kind, event]));
    assert.equal(kinds.get("compaction")?.usage.totalTokens, 150);
    assert.equal(kinds.get("cache_warm")?.usage.cacheRead, 4000);
    assert.equal(kinds.get("tool")?.toolName, "bash");
    assert.equal(result.events.find((event) => event.kind === "assistant")?.thinkingLevel, "high");
  });

  it("parses timestamps and local days", () => {
    assert.equal(parseTimestamp("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(parseTimestamp(1_700_000_000), 1_700_000_000_000);
    assert.equal(parseTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(parseTimestamp("nope"), 0);
    assert.match(localDay(Date.parse("2026-01-02T09:00:00.000Z")), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("reuses cached parses until a file changes", async () => {
    const result = await scan();
    const first = result.events[0]!;
    const second = await scanSessions({ dirs: [fixture.root] });
    assert.equal(second.events[0]!.id, first.id);
    assert.ok(second.generatedAt >= result.generatedAt);
  });
});

describe("aggregate", () => {
  it("computes totals, buckets and facets", async () => {
    const result = await scan();
    const stats = aggregate(result, {}, Date.parse("2026-03-05T00:00:00.000Z"));
    assert.equal(stats.totals.input, 3610);
    assert.equal(stats.totals.output, 655);
    assert.equal(stats.totals.totalTokens, 8865);
    assert.equal(stats.totals.requests, 6);
    assert.equal(stats.sessionsIncluded, 2);
    assert.equal(stats.eventsIncluded, 6);
    assert.equal(stats.byModel.length, 2);
    assert.equal(stats.byModel[0]!.key, "anthropic/claude-x");
    assert.equal(stats.byModel[0]!.usage.totalTokens, 6400);
    assert.equal(stats.byModel[1]!.key, "openai/gpt-y");
    assert.equal(stats.byProject.length, 2);
    assert.equal(stats.facets.models.length, 2);
    assert.equal(stats.facets.sessions.length, 3);
    assert.ok(stats.byDay.length >= 32);
    assert.equal(stats.byDay.find((day) => day.day === "2026-01-01")!.usage.totalTokens, 1800);
    assert.equal(stats.byDay.find((day) => day.day === "2026-02-01")!.usage.totalTokens, 600);
    assert.equal(stats.scannedFiles, 3);
  });

  it("filters by date range inclusively", async () => {
    const result = await scan();
    const stats = aggregate(result, { from: "2026-01-02", to: "2026-01-02" });
    assert.equal(stats.totals.totalTokens, 6465);
    assert.equal(stats.byDay.length, 1);
    assert.equal(stats.sessionsIncluded, 1);
  });

  it("filters by model, project, session and kind", async () => {
    const result = await scan();
    assert.equal(aggregate(result, { models: ["anthropic/claude-x"] }).totals.totalTokens, 6400);
    assert.equal(aggregate(result, { projects: ["/work/beta"] }).totals.totalTokens, 600);
    assert.equal(aggregate(result, { sessionIds: ["s-beta"] }).totals.totalTokens, 600);
    assert.equal(aggregate(result, { kinds: ["cache_warm"] }).totals.totalTokens, 4000);
    assert.equal(aggregate(result, { models: ["does/not-exist"] }).totals.totalTokens, 0);
  });

  it("supports relative day filters and invalid dates", async () => {
    const now = Date.parse("2026-02-02T12:00:00.000Z");
    const applied = applyFilterInput({ days: 2 }, now);
    assert.ok(applied.from && applied.from < now);
    assert.equal(applyFilterInput({ from: "not-a-date" }, now).from, undefined);
    assert.equal(applyFilterInput({ from: "-3d" }, now).from, now - 3 * 86_400_000);
  });

  it("returns session detail with per-model and per-kind buckets", async () => {
    const result = await scan();
    const detail = sessionDetail(result, "s-alpha");
    assert.ok(detail);
    assert.equal(detail.events.length, 5);
    assert.equal(detail.byModel.length, 2);
    assert.deepEqual(
      detail.byKind.map((bucket) => bucket.kind).sort(),
      ["assistant", "cache_warm", "compaction", "tool"],
    );
    assert.equal(sessionDetail(result, "missing"), undefined);
  });
});

describe("csv export", () => {
  it("emits a stable header and one row per event", async () => {
    const result = await scan();
    const csv = eventsToCsv(result);
    assert.ok(csv.startsWith("timestamp,day,session_id,session_name,project,provider,model,kind"));
    assert.equal(csv.trimEnd().split("\n").length, 7);
    assert.match(csv, /cache_warm/);
  });

  it("exports sessions and daily rollups", async () => {
    const result = await scan();
    const sessions = sessionsToCsv(result);
    assert.equal(sessions.trimEnd().split("\n").length, 4);
    const daily = dailyToCsv(result);
    assert.match(daily, /^day,requests,input,output/);
    assert.match(daily, /2026-02-01,1,500,100,0,0,600/);
  });
});

describe("formatting", () => {
  it("formats tokens, costs and charts", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(2_500_000), "2.5M");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(0.0042), "$0.0042");
    assert.equal(formatCost(1.234), "$1.23");
    assert.equal(bar(5, 10, 4), "██░░");
    assert.equal(stackedBar([{ value: 1, char: "a" }, { value: 1, char: "b" }], 4), "aabb");
    assert.equal(sparkline([0, 1, 2]).length, 3);
  });
});

describe("web server", () => {
  it("serves the dashboard with a token, the API, CSVs, and rejects bad tokens", async () => {
    const { startWebServer } = await import("../src/web/server.ts");
    const server = await startWebServer({ dirs: [fixture.root], port: 0, token: "secret-token", watch: false });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const html = await fetch(`${base}/?token=secret-token`);
      assert.equal(html.status, 200);
      const body = await html.text();
      assert.match(body, /pi token viewer/);
      assert.match(body, /data-token="secret-token"/);
      assert.doesNotMatch(body, /__TOKEN__/);

      const denied = await fetch(`${base}/?token=wrong`);
      assert.equal(denied.status, 403);

      const stats = await (await fetch(`${base}/api/stats?token=secret-token`)).json();
      assert.equal(stats.totals.totalTokens, 8865);
      assert.equal(stats.scannedFiles, 3);

      const filtered = await (
        await fetch(`${base}/api/stats?token=secret-token&models=openai%2Fgpt-y`)
      ).json();
      assert.equal(filtered.totals.totalTokens, 2465);

      const range = await (await fetch(`${base}/api/stats?token=secret-token&range=7`)).json();
      assert.equal(range.totals.totalTokens, 0);

      const detail = await (await fetch(`${base}/api/session?token=secret-token&id=s-alpha`)).json();
      assert.equal(detail.session.id, "s-alpha");
      assert.equal(detail.events.length, 5);

      const csv = await fetch(`${base}/api/export?token=secret-token&dataset=daily`);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-disposition") ?? "", /pi-tokens-daily/);
      assert.match(await csv.text(), /2026-01-01/);

      const apiDenied = await fetch(`${base}/api/stats?token=nope`);
      assert.equal(apiDenied.status, 403);

      const badExport = await fetch(`${base}/api/export?token=secret-token&dataset=bogus`);
      assert.equal(badExport.status, 200);

      const health = await (await fetch(`${base}/api/health?token=secret-token`)).json();
      assert.equal(health.ok, true);
    } finally {
      await server.close();
    }
  });

  it("guards against non-loopback Host headers", async () => {
    const { startWebServer } = await import("../src/web/server.ts");
    const http = await import("node:http");
    const server = await startWebServer({ dirs: [fixture.root], port: 0, token: "t", watch: false });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/?token=t",
            method: "GET",
            setHost: false,
            headers: { host: "evil.example.com" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await server.close();
    }
  });
});

describe("tui dashboard", () => {
  it("renders every view within the supplied width", async () => {
    const { TokenDashboard } = await import("../src/tui/dashboard.ts");
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const result = await scan();
    const theme = {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      style: (text: string) => text,
      appearance: "dark" as const,
      colors: {},
    };
    const keybindings = {
      matches: (data: string, action: string) => {
        if (action === "tui.select.up") return data === "up";
        if (action === "tui.select.down") return data === "down";
        if (action === "tui.select.confirm") return data === "enter";
        if (action === "tui.select.cancel") return data === "escape";
        return false;
      },
    };
    const tui = { requestRender: () => undefined };
    let closed = false;
    const dashboard = new TokenDashboard(tui as never, theme as never, keybindings as never, () => {
      closed = true;
    }, {
      scan: result,
      reload: async () => result,
      openWeb: async () => undefined,
      exportCsv: async () => "/tmp/out.csv",
    });

    for (const width of [48, 72, 100, 140]) {
      for (const view of ["1", "2", "3", "4"]) {
        dashboard.handleInput(view);
        const lines = dashboard.render(width);
        assert.ok(lines.length > 5);
        for (const rendered of lines) {
          assert.ok(visibleWidth(rendered) <= width, `line too wide at ${width}: ${rendered}`);
        }
      }
    }

    dashboard.handleInput("?");
    assert.ok(dashboard.render(80).some((line) => line.includes("Keyboard shortcuts")));

    dashboard.handleInput("3");
    dashboard.handleInput("down");
    dashboard.handleInput("enter");
    const detail = dashboard.render(100).join("\n");
    assert.match(detail, /Models|Recent requests/);

    dashboard.handleInput("q");
    dashboard.handleInput("q");
    assert.equal(closed, true);
  });
});
