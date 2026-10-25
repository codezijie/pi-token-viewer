/** Shared on-disk session fixture for the test suite. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Fixture {
  root: string;
  cleanup: () => void;
}

function usage(partial: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
  cost?: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
}) {
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  return {
    input: partial.input,
    output: partial.output,
    cacheRead,
    cacheWrite,
    ...(partial.reasoning !== undefined ? { reasoning: partial.reasoning } : {}),
    totalTokens: partial.total ?? partial.input + partial.output + cacheRead + cacheWrite,
    cost: {
      input: partial.costInput ?? 0,
      output: partial.costOutput ?? 0,
      cacheRead: partial.costCacheRead ?? 0,
      cacheWrite: partial.costCacheWrite ?? 0,
      total: partial.cost ?? 0,
    },
  };
}

/** Strings pass through verbatim so malformed lines can be tested. */
function line(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function writeSession(root: string, folder: string, file: string, rows: unknown[]): void {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), rows.map(line).join("\n") + "\n", "utf8");
}

/**
 * Fixture totals:
 *   6 events, 3 session files, 2 projects, 2 models, 8865 tokens, $0.851.
 * Includes assistant turns, a tool sub-call, cache warming, compaction,
 * a header-only session, a named session and one malformed line.
 */
export function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "pi-token-viewer-test-"));

  writeSession(root, "--work-alpha--", "2026-01-01T00-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444.jsonl", [
    { type: "session", version: 3, id: "s-alpha", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/work/alpha" },
    { type: "session_info", id: "i0", parentId: null, timestamp: "2026-01-01T10:00:01.000Z", name: "Alpha work" },
    {
      type: "message",
      id: "m1",
      parentId: "i0",
      timestamp: "2026-01-01T10:01:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-x",
        thinkingLevel: "high",
        usage: usage({ input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, reasoning: 50, cost: 0.5 }),
        content: [{ type: "text", text: "hi" }],
      },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-01-01T10:02:00.000Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-01-02T09:00:00.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-y",
        usage: usage({ input: 2000, output: 300, cost: 0.25 }),
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: "2026-01-02T09:07:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        isError: false,
        usage: usage({ input: 10, output: 5, cost: 0.001 }),
      },
    },
    {
      type: "usage",
      id: "u1",
      parentId: "m4",
      timestamp: "2026-01-02T09:05:00.000Z",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude-x",
      usage: usage({ input: 0, output: 0, cacheRead: 4000, cost: 0.04, costCacheRead: 0.04 }),
    },
    {
      type: "compaction",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-02T09:06:00.000Z",
      summary: "summary",
      firstKeptEntryId: "m3",
      usage: usage({ input: 100, output: 50, cost: 0.01 }),
    },
    "{ this is not json",
    { type: "label", id: "l1", parentId: "c1", timestamp: "2026-01-02T09:08:00.000Z", targetId: "m1", label: "ok" },
  ]);

  writeSession(root, "--work-beta--", "2026-02-01T00-00-00-000Z_bbbbbbbb-1111-2222-3333-444444444444.jsonl", [
    { type: "session", version: 3, id: "s-beta", timestamp: "2026-02-01T12:00:00.000Z", cwd: "/work/beta" },
    {
      type: "message",
      id: "b1",
      parentId: null,
      timestamp: "2026-02-01T12:00:30.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-x",
        usage: usage({ input: 500, output: 100, cost: 0.05 }),
        content: [],
      },
    },
  ]);

  writeSession(root, "--work-empty--", "2026-03-01T00-00-00-000Z_cccccccc-1111-2222-3333-444444444444.jsonl", [
    { type: "session", version: 3, id: "s-empty", timestamp: "2026-03-01T08:00:00.000Z", cwd: "/work/empty" },
  ]);

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
