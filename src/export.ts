/** CSV export helpers (shared by `/tokens export` and the web endpoint). */

import type { ScanResult } from "./types.ts";
import { localDay } from "./scanner.ts";

const HEADER = [
  "timestamp",
  "day",
  "session_id",
  "session_name",
  "project",
  "provider",
  "model",
  "kind",
  "kind_detail",
  "tool",
  "thinking",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
  "total_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
];

export function eventsToCsv(scan: ScanResult): string {
  const rows: string[] = [HEADER.join(",")];
  for (const event of scan.events) {
    rows.push(
      [
        new Date(event.timestamp).toISOString(),
        event.day,
        event.sessionId,
        event.sessionName,
        event.project,
        event.provider,
        event.model,
        event.kind,
        event.kindDetail ?? "",
        event.toolName ?? "",
        event.thinkingLevel ?? "",
        event.usage.input,
        event.usage.output,
        event.usage.cacheRead,
        event.usage.cacheWrite,
        event.usage.reasoning,
        event.usage.totalTokens,
        round(event.usage.cost.input),
        round(event.usage.cost.output),
        round(event.usage.cost.cacheRead),
        round(event.usage.cost.cacheWrite),
        round(event.usage.cost.total),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

export function sessionsToCsv(scan: ScanResult): string {
  const header = [
    "session_id",
    "name",
    "project",
    "started_at",
    "last_activity",
    "messages",
    "user_messages",
    "assistant_messages",
    "tool_calls",
    "models",
    "requests",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "total_tokens",
    "cost_total",
  ];
  const rows = [header.join(",")];
  for (const session of scan.sessions) {
    rows.push(
      [
        session.id,
        session.name,
        session.project,
        session.startedAt ? new Date(session.startedAt).toISOString() : "",
        session.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : "",
        session.messageCount,
        session.userMessages,
        session.assistantMessages,
        session.toolCalls,
        session.models.join(" "),
        session.usage.requests,
        session.usage.input,
        session.usage.output,
        session.usage.cacheRead,
        session.usage.cacheWrite,
        session.usage.totalTokens,
        round(session.usage.cost.total),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

/** Daily rollup CSV, handy for spreadsheets. */
export function dailyToCsv(scan: ScanResult): string {
  const map = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; requests: number }>();
  for (const event of scan.events) {
    const day = event.day || localDay(event.timestamp);
    let entry = map.get(day);
    if (!entry) {
      entry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
      map.set(day, entry);
    }
    entry.input += event.usage.input;
    entry.output += event.usage.output;
    entry.cacheRead += event.usage.cacheRead;
    entry.cacheWrite += event.usage.cacheWrite;
    entry.cost += event.usage.cost.total;
    entry.requests += event.usage.requests;
  }
  const header = ["day", "requests", "input", "output", "cache_read", "cache_write", "total_tokens", "cost_total"];
  const rows = [header.join(",")];
  for (const day of [...map.keys()].sort()) {
    const entry = map.get(day)!;
    rows.push(
      [
        day,
        entry.requests,
        entry.input,
        entry.output,
        entry.cacheRead,
        entry.cacheWrite,
        entry.input + entry.output + entry.cacheRead + entry.cacheWrite,
        round(entry.cost),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
