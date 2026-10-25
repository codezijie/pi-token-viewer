import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { clearScanCache } from "../src/scanner.ts";
import { createFixture, type Fixture } from "./fixture.ts";

interface Notice {
  message: string;
  type: string;
}

interface FakePi {
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; description?: string }>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>;
  handlers: Map<string, (...args: unknown[]) => Promise<void>>;
}

let fixture: Fixture;
let outDir: string;
let fakePi: FakePi;
let notices: Notice[];
let ctx: Record<string, unknown>;

before(async () => {
  fixture = createFixture();
  outDir = mkdtempSync(path.join(tmpdir(), "pi-token-viewer-out-"));
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.root;

  fakePi = { commands: new Map(), tools: new Map(), handlers: new Map() };
  const extension = await import("../extensions/token-viewer/index.ts");
  extension.default({
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
      fakePi.handlers.set(event, handler);
      return () => undefined;
    },
    registerCommand: (name: string, options: unknown) => {
      fakePi.commands.set(name, options as never);
    },
    registerTool: (tool: unknown) => {
      const typed = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
      fakePi.tools.set(typed.name, typed);
    },
  } as never);

  notices = [];
  ctx = {
    mode: "tui",
    cwd: outDir,
    ui: {
      notify: (message: string, type = "info") => notices.push({ message, type }),
      setStatus: () => undefined,
    },
  };
});

after(async () => {
  const shutdown = fakePi.handlers.get("session_shutdown");
  if (shutdown) await shutdown({}, ctx);
  clearScanCache();
  fixture?.cleanup();
  rmSync(outDir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

function lastNotice(): Notice {
  const notice = notices[notices.length - 1];
  assert.ok(notice, "expected a notification");
  return notice;
}

async function run(command: string): Promise<void> {
  const handler = fakePi.commands.get("tokens");
  assert.ok(handler, "tokens command is registered");
  notices = [];
  await handler.handler(command, ctx);
}

describe("extension wiring", () => {
  it("registers the command and the codemode tool", () => {
    assert.ok(fakePi.commands.has("tokens"));
    assert.ok(fakePi.tools.has("token_usage"));
    assert.ok(fakePi.handlers.has("session_shutdown"));
  });

  it("summarises usage for the notification area", async () => {
    await run("summary");
    const notice = lastNotice();
    assert.match(notice.message, /tokens · \$/);
    assert.match(notice.message, /sessions/);
    assert.match(notice.message, /in .* out .* cache/);
    assert.equal(notice.type, "info");
  });

  it("writes CSV exports into the working directory", async () => {
    await run("export sessions");
    const notice = lastNotice();
    const file = /Wrote (.+)$/.exec(notice.message)?.[1];
    assert.ok(file, notice.message);
    const csv = readFileSync(file, "utf8");
    assert.equal(csv.trimEnd().split("\n").length, 4);
    assert.match(csv, /s-alpha/);
    rmSync(file);
  });

  it("reports data and server status", async () => {
    await run("status");
    const message = lastNotice().message;
    assert.match(message, /session files: 3/);
    assert.match(message, /today:/);
    assert.match(message, /data: /);
    assert.match(message, /parse warnings: 1/);
  });

  it("starts, reports, opens and stops the web dashboard", async () => {
    await run("web --port 0 --no-open");
    const started = notices.map((notice) => notice.message).join("\n");
    const url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/.exec(started)?.[1];
    assert.ok(url, started);

    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /pi token viewer/);

    await run("status");
    assert.match(lastNotice().message, /web: http:\/\/127\.0\.0\.1:/);

    await run("open");
    assert.match(lastNotice().message, /Opened http:\/\/127\.0\.0\.1:/);

    await run("web --no-open");
    assert.match(lastNotice().message, /already running/);

    await run("stop");
    assert.match(lastNotice().message, /stopped/);

    await run("stop");
    assert.match(lastNotice().message, /No web dashboard/);
  });

  it("shows help for unknown subcommands", async () => {
    await run("wat");
    assert.match(lastNotice().message, /\/tokens web/);
  });

  it("exposes the token_usage tool with filters and groupings", async () => {
    const tool = fakePi.tools.get("token_usage")!;
    const result = await tool.execute("call-1", { groupBy: "model" }, undefined, undefined, { mode: "json" });
    const text = result.content[0]!.text;
    assert.match(text, /Totals: 8\.\d+k tokens/);
    assert.match(text, /By model:/);
    assert.match(text, /anthropic\/claude-x/);
    assert.match(text, /openai\/gpt-y/);

    const byDay = await tool.execute("call-2", { groupBy: "day", limit: 3 }, undefined, undefined, { mode: "json" });
    assert.match(byDay.content[0]!.text, /By day:/);
    assert.match(byDay.content[0]!.text, /\d{4}-\d{2}-\d{2}/);

    const empty = await tool.execute("call-3", { from: "1999-01-01", to: "1999-01-02" }, undefined, undefined, {
      mode: "json",
    });
    assert.match(empty.content[0]!.text, /no usage in range/);
  });

  it("survives a final shutdown without a running server", async () => {
    const shutdown = fakePi.handlers.get("session_shutdown")!;
    await shutdown({}, ctx);
    await shutdown({}, ctx);
  });
});
