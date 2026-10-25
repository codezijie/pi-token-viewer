/**
 * Local-only HTTP server for the web dashboard.
 *
 * Security posture: binds to loopback, requires a per-run token on every route,
 * rejects requests whose Host header is not a loopback name (DNS rebinding), and
 * serves only a small fixed set of static files.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, parseDateBound, sessionDetail } from "../aggregate.ts";
import { dailyToCsv, eventsToCsv, sessionsToCsv } from "../export.ts";
import { scanSessions, resolveSessionDirs } from "../scanner.ts";
import type { ScanResult, UsageFilter, UsageKind } from "../types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, "static");

export interface WebServerOptions {
  /** Session directories to read. Defaults to pi's conventional location. */
  dirs?: string[];
  /** Loopback port; 0 picks a free port. Default 4789. */
  port?: number;
  host?: string;
  /** Open the dashboard in the default browser once listening. */
  open?: boolean;
  /** Optional fixed auth token; random by default. */
  token?: string;
  /** Serve assets from a different directory (used by the preview script). */
  staticDir?: string;
  /** Millisecond TTL of the in-memory scan used by API reads. */
  scanTtlMs?: number;
  /** Disable filesystem watching / SSE. */
  watch?: boolean;
}

export interface WebServer {
  url: string;
  port: number;
  token: string;
  dirs: string[];
  close: () => Promise<void>;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServer> {
  const dirs = resolveSessionDirs(options.dirs);
  const token = options.token ?? randomBytes(18).toString("base64url");
  const staticDir = options.staticDir ?? STATIC_DIR;
  const ttl = options.scanTtlMs ?? 1500;

  let cached: { scan: ScanResult; at: number } | undefined;
  let inflight: Promise<ScanResult> | undefined;

  const getScan = async (force = false): Promise<ScanResult> => {
    if (!force && cached && Date.now() - cached.at < ttl) return cached.scan;
    if (inflight) return inflight;
    inflight = scanSessions({ dirs })
      .then((scan) => {
        cached = { scan, at: Date.now() };
        return scan;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const broadcast = (event: string, payload: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const scheduleRefresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void getScan(true)
        .then(() => broadcast("refresh", { generatedAt: Date.now() }))
        .catch(() => broadcast("error", { message: "rescan failed" }));
    }, 400);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("method not allowed");
      return;
    }
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403);
      res.end("forbidden host");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      if (url.searchParams.get("token") !== token) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid or missing token. Re-run `/tokens web` in pi.");
        return;
      }
      const html = await readFile(path.join(staticDir, "index.html"), "utf8");
      const body = html
        .replaceAll("__TOKEN__", escapeHtml(token))
        .replaceAll("__DIRS__", escapeHtml(dirs.join(", ")))
        .replaceAll("__VERSION__", escapeHtml(version()));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
      return;
    }

    if (pathname.startsWith("/assets/")) {
      const file = pathname.slice("/assets/".length);
      if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      await serveStatic(res, path.join(staticDir, file), file);
      return;
    }

    if (pathname === "/api/health") {
      if (!authorized(url, token)) return forbidden(res);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, version: version(), dirs }));
      return;
    }

    if (pathname === "/api/events") {
      if (!authorized(url, token)) return forbidden(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      res.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
      });
      return;
    }

    if (pathname === "/api/stats") {
      if (!authorized(url, token)) return forbidden(res);
      const scan = await getScan(url.searchParams.get("refresh") === "1");
      const stats = aggregate(scan, parseFilter(url));
      sendJson(res, 200, stats, 128 * 1024);
      return;
    }

    if (pathname === "/api/session") {
      if (!authorized(url, token)) return forbidden(res);
      const id = url.searchParams.get("id") ?? "";
      const scan = await getScan();
      const detail = sessionDetail(scan, id);
      if (!detail) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      // The drawer only shows recent requests; cap the payload for very long sessions.
      detail.events = detail.events.slice(-200);
      sendJson(res, 200, detail, 512 * 1024);
      return;
    }

    if (pathname === "/api/export") {
      if (!authorized(url, token)) return forbidden(res);
      const scan = await getScan();
      const kind = url.searchParams.get("dataset") ?? url.searchParams.get("kind") ?? "events";
      const filter = parseFilter(url);
      const filtered = filterEvents(scan, filter);
      const body =
        kind === "sessions"
          ? sessionsToCsv(filtered)
          : kind === "daily"
            ? dailyToCsv(filtered)
            : eventsToCsv(filtered);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="pi-tokens-${kind}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  const port = await listenWithFallback(server, options.port ?? 4789, options.host ?? "127.0.0.1");
  const host = options.host ?? "127.0.0.1";
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/?token=${token}`;

  if (options.watch !== false) {
    for (const dir of dirs) {
      try {
        watcher = watch(dir, { recursive: true }, (_event, file) => {
          if (!file || typeof file !== "string" || file.endsWith(".jsonl")) scheduleRefresh();
        });
        break;
      } catch {
        // Recursive watching is unavailable; polling stays available via /api/stats.
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(": ping\n\n");
      } catch {
        clients.delete(client);
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  if (options.open) void openBrowser(url);

  const close = async () => {
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Do not wait for keep-alive sockets.
      setTimeout(resolve, 500).unref?.();
    });
  };

  return { url, port, token, dirs, close };
}

function filterEvents(scan: ScanResult, filter: UsageFilter): ScanResult {
  const applied = aggregate(scan, filter, Date.now()).filter;
  return {
    ...scan,
    sessions: scan.sessions.filter((session) => {
      if (applied.sessionIds.length > 0 && !applied.sessionIds.includes(session.id)) return false;
      if (applied.projects.length > 0 && !applied.projects.includes(session.project)) return false;
      return true;
    }),
    events: scan.events.filter((event) => {
      if (applied.from !== undefined && event.timestamp < applied.from) return false;
      if (applied.to !== undefined && event.timestamp > applied.to) return false;
      if (applied.models.length > 0 && !applied.models.includes(event.modelKey)) return false;
      if (applied.providers.length > 0 && !applied.providers.includes(event.provider)) return false;
      if (applied.projects.length > 0 && !applied.projects.includes(event.project)) return false;
      if (applied.sessionIds.length > 0 && !applied.sessionIds.includes(event.sessionId)) return false;
      if (applied.kinds.length > 0 && !applied.kinds.includes(event.kind)) return false;
      return true;
    }),
  };
}

export function parseFilter(url: URL): UsageFilter {
  const params = url.searchParams;
  const filter: UsageFilter = {};
  const range = params.get("range");
  if (range === "today") filter.days = 1;
  else if (/^\d+$/.test(range ?? "")) filter.days = Number(range);
  else if (range === "week") filter.days = 7;
  else if (range === "month") filter.days = 30;
  else if (range === "quarter") filter.days = 90;

  const from = params.get("from");
  const to = params.get("to");
  if (from && parseDateBound(from) !== undefined) filter.from = from;
  if (to && parseDateBound(to) !== undefined) filter.to = to;

  const models = multi(params, "model", "models");
  const providers = multi(params, "provider", "providers");
  const projects = multi(params, "project", "projects");
  const sessions = multi(params, "session", "sessions");
  const kinds = multi(params, "kind", "kinds");
  if (models.length) filter.models = models;
  if (providers.length) filter.providers = providers;
  if (projects.length) filter.projects = projects;
  if (sessions.length) filter.sessionIds = sessions;
  if (kinds.length) filter.kinds = kinds as UsageKind[];

  const limit = params.get("limit");
  if (limit && Number.isFinite(Number(limit))) filter.limit = Number(limit);
  return filter;
}

function multi(params: URLSearchParams, singular: string, plural: string): string[] {
  const values = [...params.getAll(singular), ...params.getAll(plural)];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function authorized(url: URL, token: string): boolean {
  return url.searchParams.get("token") === token;
}

function forbidden(res: ServerResponse): void {
  sendJson(res, 403, { error: "invalid token" });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, maxBytes?: number): void {
  const body = JSON.stringify(payload);
  if (maxBytes && body.length > maxBytes) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "response too large", bytes: body.length, limit: maxBytes }));
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function serveStatic(res: ServerResponse, file: string, name: string): Promise<void> {
  const types: Record<string, string> = {
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    woff2: "font/woff2",
    html: "text/html; charset=utf-8",
  };
  const ext = name.split(".").pop() ?? "";
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

async function listenWithFallback(server: http.Server, port: number, host: string): Promise<number> {
  try {
    return await listen(server, port, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return listen(server, 0, host);
    }
    throw error;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Open a URL in the platform browser. Never throws. */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? { cmd: "open", args: [url] }
      : platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : process.env.WSL_DISTRO_NAME
          ? { cmd: "wslview", args: [url] }
          : { cmd: "xdg-open", args: [url] };

  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Headless machines simply get the URL printed by the command instead.
  }
}

function version(): string {
  return process.env.PI_TOKEN_VIEWER_VERSION ?? "0.1.0";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
