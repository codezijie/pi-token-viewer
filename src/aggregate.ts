/**
 * Pure aggregation over scanned usage events.
 *
 * `aggregate()` is the single source of truth used by the TUI, the HTTP API and
 * the `token_usage` tool, so all three always agree on the numbers.
 */

import {
  addUsage,
  emptyTotals,
  type AppliedFilter,
  type Bucket,
  type DayBucket,
  type KindBucket,
  type ModelBucket,
  type ModelFacet,
  type ProjectBucket,
  type ProjectFacet,
  type ScanResult,
  type SessionBucket,
  type SessionDetail,
  type SessionFacet,
  type StatsResult,
  type UsageEvent,
  type UsageFilter,
  type UsageKind,
  type UsageTotals,
} from "./types.ts";

const MS_DAY = 86_400_000;

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function dayKey(timestamp: number): string {
  return localDayKey(new Date(timestamp));
}

function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a loose date spec: epoch ms, ISO string, `YYYY-MM-DD`, or `-7d`. */
export function parseDateBound(value: number | string | undefined, end = false, now = Date.now()): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const trimmed = value.trim();
  const relative = /^-(\d+)([dhwm])$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const span = unit === "m" ? amount * 30 * MS_DAY : unit === "w" ? amount * 7 * MS_DAY : unit === "h" ? amount * 3_600_000 : amount * MS_DAY;
    return now - span;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    return end ? endOfDay(date.getTime()) : date.getTime();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function applyFilterInput(filter: UsageFilter = {}, now = Date.now()): AppliedFilter {
  const applied: AppliedFilter = {
    models: uniq(filter.models),
    providers: uniq(filter.providers),
    projects: uniq(filter.projects),
    sessionIds: uniq(filter.sessionIds),
    kinds: uniq(filter.kinds),
  };
  const days = filter.days !== undefined && Number.isFinite(filter.days) ? Math.max(1, Math.floor(filter.days)) : undefined;
  const from = parseDateBound(filter.from, false, now);
  const to = parseDateBound(filter.to, true, now);

  if (days !== undefined) {
    // Include today, so `days=1` means "today".
    applied.from = startOfDay(now - (days - 1) * MS_DAY);
    applied.to = to;
    applied.days = days;
  } else {
    if (from !== undefined) applied.from = from;
    if (to !== undefined) applied.to = to;
  }
  return applied;
}

export function eventMatches(event: UsageEvent, filter: AppliedFilter): boolean {
  if (filter.from !== undefined && event.timestamp < filter.from) return false;
  if (filter.to !== undefined && event.timestamp > filter.to) return false;
  if (filter.models.length > 0 && !filter.models.includes(event.modelKey)) return false;
  if (filter.providers.length > 0 && !filter.providers.includes(event.provider)) return false;
  if (filter.projects.length > 0 && !filter.projects.includes(event.project)) return false;
  if (filter.sessionIds.length > 0 && !filter.sessionIds.includes(event.sessionId)) return false;
  if (filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) return false;
  return true;
}

export function aggregate(scan: ScanResult, filterInput: UsageFilter = {}, now = Date.now()): StatsResult {
  const filter = applyFilterInput(filterInput, now);
  const filtered = scan.events.filter((event) => eventMatches(event, filter));

  const totals = sumEvents(filtered);
  const unfilteredTotals = sumEvents(scan.events);
  const limit = clampLimit(filterInput.limit);

  const byModel = bucketModels(filtered, totals.totalTokens).slice(0, limit.models);
  const byProject = bucketProjects(filtered, totals.totalTokens).slice(0, limit.projects);
  const bySession = bucketSessions(filtered, totals.totalTokens).slice(0, limit.sessions);
  const byKind = bucketKinds(filtered, totals.totalTokens);
  const byDay = bucketDays(filtered, filter, limit.days);

  const facets = {
    models: modelFacets(scan.events).slice(0, 200),
    providers: [...new Set(scan.events.map((event) => event.provider))].sort(),
    projects: projectFacets(scan.events).slice(0, 200),
    sessions: sessionFacets(scan).slice(0, 300),
    kinds: [...new Set(scan.events.map((event) => event.kind))].sort() as UsageKind[],
    days: bucketDays(scan.events, {}, 366).map((bucket) => bucket.day),
  };

  return {
    generatedAt: now,
    sessionsDir: scan.sessionsDir,
    filter,
    totals,
    facets,
    byDay,
    byModel,
    byProject,
    bySession,
    byKind,
    sessionsIncluded: new Set(filtered.map((event) => event.sessionId)).size,
    eventsIncluded: filtered.length,
    scannedFiles: scan.scannedFiles,
    unfiltered: {
      totals: unfilteredTotals,
      sessions: new Set(scan.events.map((event) => event.sessionId)).size,
      events: scan.events.length,
    },
    issues: scan.issues.slice(0, 25),
  };
}

export function sessionDetail(scan: ScanResult, sessionId: string): SessionDetail | undefined {
  const session = scan.sessions.find((entry) => entry.id === sessionId);
  if (!session) return undefined;
  const events = scan.events.filter((event) => event.sessionId === sessionId);
  const totals = sumEvents(events);
  return {
    session,
    events,
    byDay: bucketDays(events, {}, 366),
    byModel: bucketModels(events, totals.totalTokens),
    byKind: bucketKinds(events, totals.totalTokens),
  };
}

export function sumEvents(events: UsageEvent[]): UsageTotals {
  const totals = emptyTotals();
  for (const event of events) addUsage(totals, event.usage);
  return totals;
}

function bucketDays(events: UsageEvent[], filter: Pick<AppliedFilter, "from" | "to"> | Record<string, never>, limit: number): DayBucket[] {
  const map = new Map<string, UsageTotals>();
  for (const event of events) {
    const bucket = map.get(event.day) ?? emptyTotals();
    addUsage(bucket, event.usage);
    map.set(event.day, bucket);
  }

  const days = [...map.keys()].sort();
  const firstDay = filter.from !== undefined ? dayKey(filter.from) : days[0];
  const lastDay = filter.to !== undefined ? dayKey(filter.to) : days[days.length - 1];
  const filled: string[] = [];
  if (firstDay && lastDay && firstDay <= lastDay) {
    const cursor = new Date(`${firstDay}T00:00:00`);
    const guard = 4000;
    while (filled.length < guard) {
      const key = localDayKey(cursor);
      if (key > lastDay) break;
      filled.push(key);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  if (filled.length === 0) filled.push(...days);

  const trimmed = filled.length > limit ? filled.slice(filled.length - limit) : filled;
  const grand = [...map.values()].reduce((sum, usage) => sum + usage.totalTokens, 0);
  return trimmed.map((day) => {
    const usage = map.get(day) ?? emptyTotals();
    return {
      key: day,
      label: day,
      day,
      usage,
      requests: usage.requests,
      share: grand > 0 ? usage.totalTokens / grand : 0,
    };
  });
}

function bucketModels(events: UsageEvent[], grand: number): ModelBucket[] {
  const map = new Map<string, { usage: UsageTotals; sessions: Set<string>; provider: string; model: string }>();
  for (const event of events) {
    let entry = map.get(event.modelKey);
    if (!entry) {
      entry = { usage: emptyTotals(), sessions: new Set(), provider: event.provider, model: event.model };
      map.set(event.modelKey, entry);
    }
    addUsage(entry.usage, event.usage);
    entry.sessions.add(event.sessionId);
  }
  return [...map.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.model,
      usage: entry.usage,
      requests: entry.usage.requests,
      share: grand > 0 ? entry.usage.totalTokens / grand : 0,
      provider: entry.provider,
      model: entry.model,
      sessions: entry.sessions.size,
    }))
    .sort(compareBuckets);
}

function bucketProjects(events: UsageEvent[], grand: number): ProjectBucket[] {
  const map = new Map<string, { usage: UsageTotals; sessions: Set<string> }>();
  for (const event of events) {
    const key = event.project || "unknown";
    let entry = map.get(key);
    if (!entry) {
      entry = { usage: emptyTotals(), sessions: new Set() };
      map.set(key, entry);
    }
    addUsage(entry.usage, event.usage);
    entry.sessions.add(event.sessionId);
  }
  return [...map.entries()]
    .map(([key, entry]) => ({
      key,
      label: key,
      usage: entry.usage,
      requests: entry.usage.requests,
      share: grand > 0 ? entry.usage.totalTokens / grand : 0,
      project: key,
      cwd: key,
      sessions: entry.sessions.size,
    }))
    .sort(compareBuckets);
}

function bucketSessions(events: UsageEvent[], grand: number): SessionBucket[] {
  const map = new Map<
    string,
    {
      usage: UsageTotals;
      name: string;
      cwd: string;
      project: string;
      models: Set<string>;
      first: number;
      last: number;
    }
  >();
  for (const event of events) {
    let entry = map.get(event.sessionId);
    if (!entry) {
      entry = {
        usage: emptyTotals(),
        name: event.sessionName,
        cwd: event.cwd,
        project: event.project,
        models: new Set(),
        first: event.timestamp,
        last: event.timestamp,
      };
      map.set(event.sessionId, entry);
    }
    addUsage(entry.usage, event.usage);
    entry.models.add(event.modelKey);
    entry.first = Math.min(entry.first, event.timestamp);
    entry.last = Math.max(entry.last, event.timestamp);
  }
  return [...map.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.name,
      usage: entry.usage,
      requests: entry.usage.requests,
      share: grand > 0 ? entry.usage.totalTokens / grand : 0,
      sessionId: key,
      sessionName: entry.name,
      cwd: entry.cwd,
      project: entry.project,
      models: [...entry.models].sort(),
      startedAt: entry.first,
      lastActivityAt: entry.last,
      messages: entry.usage.requests,
    }))
    .sort(compareBuckets);
}

function bucketKinds(events: UsageEvent[], grand: number): KindBucket[] {
  const map = new Map<UsageKind, UsageTotals>();
  for (const event of events) {
    const usage = map.get(event.kind) ?? emptyTotals();
    addUsage(usage, event.usage);
    map.set(event.kind, usage);
  }
  return [...map.entries()]
    .map(([kind, usage]) => ({
      key: kind,
      label: KIND_LABELS[kind],
      kind,
      usage,
      requests: usage.requests,
      share: grand > 0 ? usage.totalTokens / grand : 0,
    }))
    .sort(compareBuckets);
}

export const KIND_LABELS: Record<UsageKind, string> = {
  assistant: "Assistant turns",
  tool: "Tool sub-calls",
  compaction: "Compaction",
  branch_summary: "Branch summaries",
  cache_warm: "Cache warming",
  usage: "Other usage",
  other: "Other",
};

function compareBuckets(a: Bucket, b: Bucket): number {
  if (b.usage.totalTokens !== a.usage.totalTokens) return b.usage.totalTokens - a.usage.totalTokens;
  return b.usage.cost.total - a.usage.cost.total;
}

function modelFacets(events: UsageEvent[]): ModelFacet[] {
  const map = new Map<string, ModelFacet>();
  for (const event of events) {
    let entry = map.get(event.modelKey);
    if (!entry) {
      entry = {
        key: event.modelKey,
        provider: event.provider,
        model: event.model,
        requests: 0,
        totalTokens: 0,
      };
      map.set(event.modelKey, entry);
    }
    entry.requests += event.usage.requests;
    entry.totalTokens += event.usage.totalTokens;
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function projectFacets(events: UsageEvent[]): ProjectFacet[] {
  const map = new Map<string, ProjectFacet>();
  for (const event of events) {
    const key = event.project || "unknown";
    let entry = map.get(key);
    if (!entry) {
      entry = { project: key, cwd: event.cwd || key, sessions: 0, totalTokens: 0 };
      map.set(key, entry);
    }
    entry.totalTokens += event.usage.totalTokens;
  }
  const sessions = new Map<string, Set<string>>();
  for (const event of events) {
    const key = event.project || "unknown";
    const set = sessions.get(key) ?? new Set<string>();
    set.add(event.sessionId);
    sessions.set(key, set);
  }
  for (const entry of map.values()) {
    entry.sessions = sessions.get(entry.project)?.size ?? 0;
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function sessionFacets(scan: ScanResult): SessionFacet[] {
  const totals = new Map<string, number>();
  for (const event of scan.events) {
    totals.set(event.sessionId, (totals.get(event.sessionId) ?? 0) + event.usage.totalTokens);
  }
  return scan.sessions
    .map((session) => ({
      id: session.id,
      name: session.name,
      project: session.project,
      lastActivityAt: session.lastActivityAt,
      totalTokens: totals.get(session.id) ?? 0,
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function clampLimit(limit: number | undefined): { days: number; models: number; projects: number; sessions: number } {
  const base = limit !== undefined && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
  return {
    days: base ? Math.min(base, 730) : 60,
    models: base ? Math.min(base, 500) : 25,
    projects: base ? Math.min(base, 500) : 25,
    sessions: base ? Math.min(base, 500) : 100,
  };
}

function uniq<T>(values: T[] | undefined): T[] {
  if (!values) return [];
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}
