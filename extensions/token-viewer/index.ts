/**
 * pi-token-viewer — token & cost analytics for pi sessions.
 *
 * Commands
 *   /tokens                 interactive TUI dashboard
 *   /tokens web             local web dashboard (light/dark), opens a browser
 *   /tokens summary         one-shot totals in the notification area
 *   /tokens export [kind]   write a CSV into the current directory
 *   /tokens status          web server + data status
 *   /tokens stop            stop the web server
 *   /tokens open            reopen the running web dashboard
 *
 * The `token_usage` tool exposes the same aggregation to the agent/codemode.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { aggregate } from "../../src/aggregate.ts";
import { dailyToCsv, eventsToCsv, sessionsToCsv } from "../../src/export.ts";
import { formatCost, formatInt, formatTokens, formatPercent } from "../../src/format.ts";
import { clearScanCache, resolveSessionDirs, scanSessions } from "../../src/scanner.ts";
import { TokenDashboard } from "../../src/tui/dashboard.ts";
import type { ScanResult, UsageFilter, UsageKind } from "../../src/types.ts";
import { openBrowser, startWebServer, type WebServer } from "../../src/web/server.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";

interface ExtensionState {
  server?: WebServer;
  dirs: string[];
  scan?: ScanResult;
  scanAt: number;
}

const state: ExtensionState = {
  dirs: resolveSessionDirs(),
  scanAt: 0,
};

const SCAN_TTL_MS = 2000;

export default function tokenViewer(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    state.dirs = resolveSessionDirs();
    // Never start servers or watchers in the factory; only remember paths here.
    ctx.ui.setStatus("token-viewer", undefined);
  });

  pi.on("session_shutdown", async () => {
    if (state.server) {
      const server = state.server;
      state.server = undefined;
      await server.close().catch(() => undefined);
    }
    clearScanCache();
  });

  pi.registerCommand("tokens", {
    description: "Token & cost analytics: TUI dashboard, local web dashboard, CSV export",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "tui", label: "tui", description: "Interactive terminal dashboard" },
        { value: "web", label: "web", description: "Local web dashboard with light/dark themes" },
        { value: "summary", label: "summary", description: "Print totals for the current filter" },
        { value: "export", label: "export", description: "Write a CSV file (events, sessions, daily)" },
        { value: "status", label: "status", description: "Show data/server status" },
        { value: "open", label: "open", description: "Open the running web dashboard" },
        { value: "stop", label: "stop", description: "Stop the web dashboard server" },
        { value: "help", label: "help", description: "Show usage" },
      ];
      return items.filter((item) => item.value.startsWith(prefix.trim()));
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const command = parsed.command || (ctx.mode === "tui" ? "tui" : "summary");
      try {
        switch (command) {
          case "tui":
            await runTui(ctx, parsed.flags);
            return;
          case "web":
          case "serve":
            await runWeb(ctx, parsed.flags);
            return;
          case "open":
            await openExisting(ctx);
            return;
          case "stop":
            await stopServer(ctx);
            return;
          case "status":
            await showStatus(ctx, parsed.flags);
            return;
          case "summary":
            await showSummary(ctx, parsed.flags);
            return;
          case "export":
            await exportCsv(ctx, parsed);
            return;
          case "help":
          default:
            showHelp(ctx);
            return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`token viewer: ${message}`, "error");
      }
    },
  });

  pi.registerTool(
    defineTool({
      name: "token_usage",
      label: "Token usage",
      description:
        "Query pi token/cost usage from local session files. Returns totals plus breakdowns by model, day, session, project or kind. " +
        "Filters: from/to (ISO date or YYYY-MM-DD), days (last N days), models (provider/model), projects, sessionIds, kinds. " +
        "Prefer this over guessing when the user asks about token spend, cache efficiency or which model/session cost most.",
      exposure: "codemode",
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: "Inclusive start date (YYYY-MM-DD or ISO)" })),
        to: Type.Optional(Type.String({ description: "Inclusive end date (YYYY-MM-DD or ISO)" })),
        days: Type.Optional(Type.Number({ description: "Only the last N days (includes today)" })),
        models: Type.Optional(Type.Array(Type.String(), { description: "provider/model keys" })),
        projects: Type.Optional(Type.Array(Type.String(), { description: "Project cwd values" })),
        sessionIds: Type.Optional(Type.Array(Type.String(), { description: "Session IDs" })),
        kinds: Type.Optional(
          Type.Array(StringEnum(["assistant", "tool", "compaction", "branch_summary", "cache_warm", "usage", "other"] as const)),
        ),
        groupBy: Type.Optional(StringEnum(["model", "day", "session", "project", "kind"] as const)),
        limit: Type.Optional(Type.Number({ description: "Max rows per breakdown (default 10, max 50)" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const scan = await loadScan();
        const stats = aggregate(scan, {
          from: params.from,
          to: params.to,
          days: params.days,
          models: params.models,
          projects: params.projects,
          sessionIds: params.sessionIds,
          kinds: params.kinds as UsageKind[] | undefined,
          limit: Math.min(50, Math.max(1, params.limit ?? 10)),
        });
        const groupBy = params.groupBy ?? "model";
        const rows = rowsForGroup(stats, groupBy).slice(0, Math.min(50, Math.max(1, params.limit ?? 10)));

        const lines = [
          `Totals: ${formatTokens(stats.totals.totalTokens)} tokens · ${formatCost(stats.totals.cost.total)} · ${formatInt(
            stats.totals.requests,
          )} requests · ${stats.sessionsIncluded} sessions`,
          `  input ${formatTokens(stats.totals.input)} · output ${formatTokens(stats.totals.output)} · cache read ${formatTokens(
            stats.totals.cacheRead,
          )} · cache write ${formatTokens(stats.totals.cacheWrite)}`,
          `  cache hit ${formatPercent(
            stats.totals.input + stats.totals.cacheRead + stats.totals.cacheWrite > 0
              ? (stats.totals.cacheRead + stats.totals.cacheWrite) /
                  (stats.totals.input + stats.totals.cacheRead + stats.totals.cacheWrite)
              : 0,
          )}`,
          "",
          `By ${groupBy}:`,
        ];
        for (const row of rows) {
          lines.push(
            `  ${row.label} — ${formatTokens(row.usage.totalTokens)} tokens · ${formatCost(row.usage.cost.total)} · ${formatInt(
              row.requests,
            )} requests`,
          );
        }
        if (rows.length === 0) lines.push("  (no usage in range)");
        lines.push("", `Session directory: ${stats.sessionsDir}`);

        if (ctx.mode !== "json") {
          // Keep the transcript readable; the full data is available via /tokens.
          lines.push("Run /tokens for the interactive dashboard, or /tokens web for the browser view.");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: undefined,
        };
      },
    }),
  );
}

// ------------------------------------------------------------------ commands

async function runTui(ctx: ExtensionCommandContext, flags: Record<string, string | true>): Promise<void> {
  if (ctx.mode !== "tui") {
    await showSummary(ctx, flags);
    ctx.ui.notify("The interactive dashboard needs pi's TUI mode. Try `/tokens web`.", "warning");
    return;
  }
  const dirs = flagString(flags, "dir") ? resolveSessionDirs(flagString(flags, "dir")!) : state.dirs;
  const scan = await scanSessions({ dirs });
  state.scan = scan;
  state.scanAt = Date.now();

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    return new TokenDashboard(tui, theme, keybindings, () => done(), {
      scan,
      reload: () => loadScan(dirs),
      openWeb: () => openWebForTui(ctx, dirs),
      exportCsv: () => writeExportFile(ctx, "events", {}),
    });
  });
}

async function openWebForTui(ctx: ExtensionCommandContext, dirs: string[]): Promise<void> {
  const server = await ensureServer(dirs, { open: true });
  ctx.ui.notify(`Web dashboard: ${server.url}`, "info");
}

async function runWeb(ctx: ExtensionCommandContext, flags: Record<string, string | true>): Promise<void> {
  const dirs = flagString(flags, "dir") ? resolveSessionDirs(flagString(flags, "dir")!) : state.dirs;
  if (state.server) {
    if (!flags["no-open"]) await openBrowser(state.server.url);
    ctx.ui.notify(`Token viewer already running: ${state.server.url}`, "info");
    return;
  }
  const port = flags.port !== undefined ? Number(flags.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    ctx.ui.notify("Invalid --port. Use 0 for a random port or 1-65535.", "error");
    return;
  }
  const server = await ensureServer(dirs, { port, open: !flags["no-open"] });
  ctx.ui.notify(`Token viewer web dashboard: ${server.url}`, "info");
  ctx.ui.notify("Press Ctrl+C or run /tokens stop to shut the server down.", "info");
}

async function ensureServer(
  dirs: string[],
  options: { port?: number; open?: boolean },
): Promise<WebServer> {
  if (state.server) return state.server;
  state.server = await startWebServer({
    dirs,
    port: options.port ?? 4789,
    open: options.open ?? false,
  });
  return state.server;
}

async function openExisting(ctx: ExtensionCommandContext): Promise<void> {
  if (!state.server) {
    ctx.ui.notify("No web dashboard is running. Start one with /tokens web.", "warning");
    return;
  }
  await openBrowser(state.server.url);
  ctx.ui.notify(`Opened ${state.server.url}`, "info");
}

async function stopServer(ctx: ExtensionCommandContext): Promise<void> {
  if (!state.server) {
    ctx.ui.notify("No web dashboard is running.", "info");
    return;
  }
  const server = state.server;
  state.server = undefined;
  await server.close();
  ctx.ui.notify("Token viewer web dashboard stopped.", "info");
}

async function showStatus(ctx: ExtensionCommandContext, flags: Record<string, string | true>): Promise<void> {
  const scan = await loadScan(state.dirs, flags["refresh"] === true);
  const stats = aggregate(scan, { days: 1 });
  const lines = [
    `session files: ${formatInt(scan.scannedFiles)} · sessions: ${formatInt(scan.sessions.length)} · events: ${formatInt(
      scan.events.length,
    )}`,
    `today: ${formatTokens(stats.totals.totalTokens)} tokens · ${formatCost(stats.totals.cost.total)} · ${formatInt(
      stats.totals.requests,
    )} requests`,
    `data: ${scan.sessionsDir}`,
  ];
  if (scan.issues.length > 0) lines.push(`parse warnings: ${scan.issues.length}`);
  if (state.server) lines.push(`web: ${state.server.url}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showSummary(ctx: ExtensionCommandContext, flags: Record<string, string | true>): Promise<void> {
  const filter = filterFromFlags(flags);
  const scan = await loadScan(state.dirs);
  const stats = aggregate(scan, filter);
  const top = stats.byModel.slice(0, 3);
  const lines = [
    `${formatTokens(stats.totals.totalTokens)} tokens · ${formatCost(stats.totals.cost.total)} · ${formatInt(
      stats.totals.requests,
    )} requests · ${stats.sessionsIncluded} sessions`,
    `in ${formatTokens(stats.totals.input)} · out ${formatTokens(stats.totals.output)} · cache ${formatTokens(
      stats.totals.cacheRead + stats.totals.cacheWrite,
    )}`,
    top.length ? `top: ${top.map((row) => `${row.key} ${formatTokens(row.usage.totalTokens)}`).join(" · ")}` : "top: —",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function exportCsv(ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<void> {
  const kind = (parsed.command2 || "events") as "events" | "sessions" | "daily";
  if (!["events", "sessions", "daily"].includes(kind)) {
    ctx.ui.notify(`Unknown export kind “${kind}”. Use events, sessions or daily.`, "error");
    return;
  }
  const file = await writeExportFile(ctx, kind, filterFromFlags(parsed.flags));
  ctx.ui.notify(`Wrote ${file}`, "info");
}

async function writeExportFile(
  ctx: ExtensionCommandContext,
  kind: "events" | "sessions" | "daily",
  filter: UsageFilter,
): Promise<string> {
  const scan = await loadScan(state.dirs);
  const stats = aggregate(scan, filter);
  const filtered: ScanResult = {
    ...scan,
    events: scan.events.filter((event) => {
      if (stats.filter.from !== undefined && event.timestamp < stats.filter.from) return false;
      if (stats.filter.to !== undefined && event.timestamp > stats.filter.to) return false;
      if (stats.filter.models.length && !stats.filter.models.includes(event.modelKey)) return false;
      if (stats.filter.projects.length && !stats.filter.projects.includes(event.project)) return false;
      if (stats.filter.sessionIds.length && !stats.filter.sessionIds.includes(event.sessionId)) return false;
      if (stats.filter.kinds.length && !stats.filter.kinds.includes(event.kind)) return false;
      return true;
    }),
  };
  const body = kind === "sessions" ? sessionsToCsv(filtered) : kind === "daily" ? dailyToCsv(filtered) : eventsToCsv(filtered);
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(ctx.cwd, `pi-tokens-${kind}-${stamp}.csv`);
  await writeFile(file, body, "utf8");
  return file;
}

function showHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    [
      "/tokens                interactive TUI dashboard",
      "/tokens web [--port N] [--no-open]   local web dashboard",
      "/tokens summary [--days N] [--model k] [--project p] [--session id]",
      "/tokens export [events|sessions|daily]   write CSV to the cwd",
      "/tokens status | open | stop",
    ].join("\n"),
    "info",
  );
}

// -------------------------------------------------------------------- shared

async function loadScan(dirs = state.dirs, force = false): Promise<ScanResult> {
  if (!force && state.scan) {
    const freshEnough = Date.now() - state.scanAt < SCAN_TTL_MS;
    if (freshEnough) return state.scan;
  }
  const scan = await scanSessions({ dirs, cache: !force });
  state.scan = scan;
  state.scanAt = Date.now();
  return scan;
}

interface ParsedArgs {
  command: string;
  command2?: string;
  flags: Record<string, string | true>;
}

function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const [rawKey, rawValue] = token.slice(2).split("=", 2);
      if (!rawKey) continue;
      if (rawValue !== undefined) {
        flags[rawKey] = rawValue;
      } else {
        const next = tokens[i + 1];
        if (next && !next.startsWith("--")) {
          flags[rawKey] = next;
          i++;
        } else {
          flags[rawKey] = true;
        }
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const rawKey = token.slice(1);
      const next = tokens[i + 1];
      if (next && !next.startsWith("-")) {
        flags[rawKey] = next;
        i++;
      } else {
        flags[rawKey] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return {
    command: positional[0] ?? "",
    command2: positional[1],
    flags,
  };
}

function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function filterFromFlags(flags: Record<string, string | true>): UsageFilter {
  const filter: UsageFilter = {};
  const days = flagString(flags, "days") ?? flagString(flags, "d");
  if (days) filter.days = Number(days);
  const from = flagString(flags, "from");
  const to = flagString(flags, "to");
  if (from) filter.from = from;
  if (to) filter.to = to;
  const model = flagString(flags, "model") ?? flagString(flags, "m");
  if (model) filter.models = splitList(model);
  const project = flagString(flags, "project") ?? flagString(flags, "p");
  if (project) filter.projects = splitList(project);
  const session = flagString(flags, "session") ?? flagString(flags, "s");
  if (session) filter.sessionIds = splitList(session);
  const kind = flagString(flags, "kind") ?? flagString(flags, "k");
  if (kind) filter.kinds = splitList(kind) as UsageKind[];
  return filter;
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function rowsForGroup(
  stats: ReturnType<typeof aggregate>,
  groupBy: "model" | "day" | "session" | "project" | "kind",
) {
  switch (groupBy) {
    case "day":
      return stats.byDay.map((row) => ({ label: row.day, usage: row.usage, requests: row.requests }));
    case "session":
      return stats.bySession.map((row) => ({ label: row.sessionName, usage: row.usage, requests: row.requests }));
    case "project":
      return stats.byProject.map((row) => ({ label: row.project, usage: row.usage, requests: row.requests }));
    case "kind":
      return stats.byKind.map((row) => ({ label: row.label, usage: row.usage, requests: row.requests }));
    default:
      return stats.byModel.map((row) => ({ label: row.key, usage: row.usage, requests: row.requests }));
  }
}
