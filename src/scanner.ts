/**
 * Session scanner: turns pi's JSONL session files into billable usage events.
 *
 * Design notes
 * - Every entry on every branch is counted. Abandoned branches still cost money,
 *   so this is a billing view, not a "current context" view.
 * - Files are cached by (mtimeMs, size) so refreshing the dashboards is cheap even
 *   with thousands of session files.
 * - Parsing is defensive: a malformed line or an unknown entry type never throws.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  addUsage,
  emptyCost,
  emptyTotals,
  type ScanIssue,
  type ScanResult,
  type SessionSummary,
  type UsageEvent,
  type UsageKind,
  type UsageTotals,
} from "./types.ts";

export interface ScannerOptions {
  /** One or more session directories. Defaults to pi's conventional location. */
  dirs?: string[];
  /** Include sessions from every project (default true). */
  cache?: boolean;
}

interface ParsedFile {
  summary: Omit<SessionSummary, "usage"> & { usage: UsageTotals };
  events: UsageEvent[];
  issues: ScanIssue[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

const fileCache = new Map<string, CacheEntry>();

export function clearScanCache(): void {
  fileCache.clear();
}

/** Resolve the session directories this process should read. */
export function resolveSessionDirs(explicit?: string | string[]): string[] {
  const list = explicit === undefined ? [] : Array.isArray(explicit) ? explicit : [explicit];
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  const candidates = list.length > 0 ? list : fromEnv ? [fromEnv] : [path.join(piAgentDir(), "sessions")];
  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

/** Scan every session directory and merge the results. */
export async function scanSessions(options: ScannerOptions = {}): Promise<ScanResult> {
  const dirs = resolveSessionDirs(options.dirs);
  const useCache = options.cache !== false;

  const sessions: SessionSummary[] = [];
  const events: UsageEvent[] = [];
  const issues: ScanIssue[] = [];
  let scannedFiles = 0;

  for (const dir of dirs) {
    const files = await listSessionFiles(dir);
    scannedFiles += files.length;
    for (const file of files) {
      const parsed = await parseSessionFile(file, useCache);
      if (!parsed) continue;
      sessions.push(parsed.summary);
      events.push(...parsed.events);
      issues.push(...parsed.issues);
    }
  }

  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    sessionsDir: dirs.join(", "),
    scannedFiles,
    sessions,
    events,
    issues,
    generatedAt: Date.now(),
  };
}

async function listSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function parseSessionFile(file: string, useCache: boolean): Promise<ParsedFile | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    fileCache.delete(file);
    return undefined;
  }

  const cached = useCache ? fileCache.get(file) : undefined;
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.parsed;
  }

  const parsed = await parseSessionFileUncached(file);
  if (!parsed) return undefined;
  fileCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, parsed });
  return parsed;
}

async function parseSessionFileUncached(file: string): Promise<ParsedFile | undefined> {
  const folder = path.basename(path.dirname(file));
  let header: Record<string, unknown> | undefined;
  const events: UsageEvent[] = [];
  const issues: ScanIssue[] = [];

  let name = "";
  let cwd = "";
  let version = 1;
  let startedAt = 0;
  let lastActivityAt = 0;
  let messageCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let parentSession: string | undefined;
  let lineNumber = 0;
  let lastProvider = "";
  let lastModel = "";

  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (issues.length < 10) {
          issues.push({ file, message: `line ${lineNumber}: invalid JSON` });
        }
        continue;
      }

      const type = typeof entry.type === "string" ? entry.type : "";
      const timestamp = parseTimestamp(entry.timestamp);

      if (type === "session") {
        header = entry;
        cwd = typeof entry.cwd === "string" ? entry.cwd : "";
        version = typeof entry.version === "number" ? entry.version : 1;
        parentSession = typeof entry.parentSession === "string" ? entry.parentSession : undefined;
        startedAt = timestamp || startedAt;
        continue;
      }

      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (timestamp > lastActivityAt) lastActivityAt = timestamp;
      }

      if (type === "session_info") {
        if (typeof entry.name === "string") name = entry.name;
        continue;
      }

      if (type === "model_change") {
        if (typeof entry.provider === "string") lastProvider = entry.provider;
        if (typeof entry.modelId === "string") lastModel = entry.modelId;
        continue;
      }

      if (type === "message") {
        const message = asRecord(entry.message);
        if (!message) continue;
        messageCount++;
        const role = typeof message.role === "string" ? message.role : "";
        if (role === "user") userMessages++;
        if (role === "assistant") {
          assistantMessages++;
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              const item = asRecord(block);
              if (item && item.type === "toolCall") toolCalls++;
            }
          }
        }
        const usage = normalizeUsage(message.usage);
        if (!usage) continue;
        const provider = typeof message.provider === "string" ? message.provider : lastProvider || "unknown";
        const model = typeof message.model === "string" ? message.model : lastModel || "unknown";
        if (provider !== "unknown") lastProvider = provider;
        if (model !== "unknown") lastModel = model;
        events.push(
          makeEvent({
            file,
            folder,
            entry,
            timestamp,
            sessionId: sessionIdOf(entry, file),
            provider,
            model,
            kind: role === "toolResult" ? "tool" : role === "assistant" ? "assistant" : "other",
            usage,
            toolName: typeof message.toolName === "string" ? message.toolName : undefined,
            thinkingLevel: typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined,
            cwd,
            name,
          }),
        );
        continue;
      }

      if (type === "usage" || type === "compaction" || type === "branch_summary") {
        const usage = normalizeUsage(entry.usage);
        if (!usage) continue;
        const kindDetail = type === "usage" && typeof entry.kind === "string" ? entry.kind : undefined;
        const kind: UsageKind =
          type === "compaction"
            ? "compaction"
            : type === "branch_summary"
              ? "branch_summary"
              : kindDetail === "cache_warm"
                ? "cache_warm"
                : "usage";
        events.push(
          makeEvent({
            file,
            folder,
            entry,
            timestamp,
            sessionId: sessionIdOf(entry, file),
            provider: typeof entry.provider === "string" ? entry.provider : lastProvider || "unknown",
            model: typeof entry.model === "string" ? entry.model : lastModel || "unknown",
            kind,
            kindDetail,
            usage,
            cwd,
            name,
          }),
        );
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (!header && events.length === 0) return undefined;

  const sessionId = header && typeof header.id === "string" ? header.id : sessionIdFromFilename(file);
  const usage = emptyTotals();
  const models = new Set<string>();
  const providers = new Set<string>();
  for (const event of events) {
    addUsage(usage, event.usage);
    models.add(event.modelKey);
    providers.add(event.provider);
  }
  // Events created before the session name was known need the final name.
  for (const event of events) {
    event.sessionId = sessionId;
    event.sessionName = name || fallbackName(sessionId, event.cwd || cwd);
    event.cwd = event.cwd || cwd;
    event.project = projectFromCwd(event.cwd) || projectFromFolder(folder);
  }

  const headerTime = header ? parseTimestamp(header.timestamp) : 0;
  const summary: SessionSummary = {
    id: sessionId,
    name: name || fallbackName(sessionId, cwd || events[0]?.cwd || ""),
    file,
    cwd: cwd || events[0]?.cwd || "",
    project: projectFromCwd(cwd || events[0]?.cwd || "") || projectFromFolder(folder),
    startedAt: headerTime || startedAt,
    lastActivityAt: lastActivityAt || headerTime,
    version,
    parentSession,
    messageCount,
    userMessages,
    assistantMessages,
    toolCalls,
    models: [...models].sort(),
    providers: [...providers].sort(),
    usage,
  };

  // Rewrite event ids with the final session id so ids stay stable and unique.
  for (const event of events) {
    event.id = `${sessionId}:${event.id.slice(event.id.indexOf(":") + 1)}`;
  }

  return { summary, events, issues };
}

interface MakeEventInput {
  file: string;
  folder: string;
  entry: Record<string, unknown>;
  timestamp: number;
  sessionId: string;
  provider: string;
  model: string;
  kind: UsageKind;
  kindDetail?: string;
  usage: UsageTotals;
  toolName?: string;
  thinkingLevel?: string;
  cwd: string;
  name: string;
}

function makeEvent(input: MakeEventInput): UsageEvent {
  const entryId = typeof input.entry.id === "string" ? input.entry.id : `t${input.timestamp}`;
  const ts = input.timestamp || Date.now();
  return {
    id: `${input.sessionId}:${entryId}`,
    sessionId: input.sessionId,
    sessionName: input.name || fallbackName(input.sessionId, input.cwd),
    sessionFile: input.file,
    project: projectFromCwd(input.cwd) || projectFromFolder(input.folder),
    cwd: input.cwd,
    provider: input.provider,
    model: input.model,
    modelKey: `${input.provider}/${input.model}`,
    kind: input.kind,
    kindDetail: input.kindDetail,
    toolName: input.toolName,
    thinkingLevel: input.thinkingLevel,
    timestamp: ts,
    day: localDay(ts),
    usage: cloneUsage(input.usage),
  };
}

/** Public, usage-free projection for list endpoints. */
export function publicEvent(event: UsageEvent): UsageEvent {
  const { usage: _usage, ...rest } = event;
  return rest as UsageEvent;
}

function normalizeUsage(value: unknown): UsageTotals | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const num = (key: string): number => {
    const v = record[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const costRecord = asRecord(record.cost);
  const cost = emptyCost();
  if (costRecord) {
    cost.input = toNumber(costRecord.input);
    cost.output = toNumber(costRecord.output);
    cost.cacheRead = toNumber(costRecord.cacheRead);
    cost.cacheWrite = toNumber(costRecord.cacheWrite);
    cost.total = toNumber(costRecord.total);
  }
  const input = num("input");
  const output = num("output");
  const cacheRead = num("cacheRead");
  const cacheWrite = num("cacheWrite");
  const totalTokens = record.totalTokens === undefined ? input + output + cacheRead + cacheWrite : num("totalTokens");
  if (input + output + cacheRead + cacheWrite + totalTokens === 0 && cost.total === 0) return undefined;
  if (cost.total === 0) {
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: num("reasoning"),
    totalTokens,
    cost,
    requests: 1,
  };
}

function cloneUsage(usage: UsageTotals): UsageTotals {
  return { ...usage, cost: { ...usage.cost } };
}

export function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Decode a session folder name such as `--home-me-code--` back into a path. */
export function projectFromFolder(folder: string): string {
  const trimmed = folder.replace(/^-+|-+$/g, "");
  if (!trimmed) return "unknown";
  return `/${trimmed.replace(/-/g, "/")}`.replace(/\/+/g, "/");
}

export function projectFromCwd(cwd: string): string {
  return cwd ? cwd : "";
}

function sessionIdFromFilename(file: string): string {
  const base = path.basename(file, ".jsonl");
  const index = base.lastIndexOf("_");
  return index >= 0 ? base.slice(index + 1) : base;
}

function sessionIdOf(entry: Record<string, unknown>, file: string): string {
  const sessionId = entry.sessionId;
  if (typeof sessionId === "string" && sessionId) return sessionId;
  return sessionIdFromFilename(file);
}

function fallbackName(sessionId: string, cwd = ""): string {
  const short = sessionId.slice(0, 8);
  if (!cwd) return short;
  const base = path.basename(cwd);
  return base && base !== "/" ? `${base} · ${short}` : short;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
