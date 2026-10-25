/**
 * Shared data model for the token viewer.
 *
 * Everything here is plain JSON so it can cross the extension boundary into the
 * TUI, the HTTP API, and the browser without any runtime-specific types.
 */

export const USAGE_KINDS = [
  "assistant",
  "tool",
  "compaction",
  "branch_summary",
  "cache_warm",
  "usage",
  "other",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of output, as reported by providers that expose it. */
  reasoning: number;
  totalTokens: number;
  cost: CostBreakdown;
  /** Number of billable requests / usage records contributing to the totals. */
  requests: number;
}

/** One billable usage record extracted from a session file. */
export interface UsageEvent {
  /** `${sessionId}:${entryId}` */
  id: string;
  sessionId: string;
  sessionName: string;
  sessionFile: string;
  /** Project directory name derived from the session folder (`--home-me-code--` -> `/home/me/code`). */
  project: string;
  cwd: string;
  provider: string;
  model: string;
  /** `provider/model` */
  modelKey: string;
  usage: UsageTotals;
  kind: UsageKind;
  /** Raw `kind` value for session `usage` entries (e.g. `cache_warm`). */
  kindDetail?: string;
  toolName?: string;
  thinkingLevel?: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  file: string;
  cwd: string;
  project: string;
  /** Epoch milliseconds of the session header, or the first parsed entry. */
  startedAt: number;
  /** Epoch milliseconds of the most recent parsed entry. */
  lastActivityAt: number;
  version: number;
  parentSession?: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  models: string[];
  providers: string[];
  usage: UsageTotals;
}

export interface ScanIssue {
  file: string;
  message: string;
}

export interface ScanResult {
  sessionsDir: string;
  scannedFiles: number;
  sessions: SessionSummary[];
  events: UsageEvent[];
  issues: ScanIssue[];
  generatedAt: number;
}

/** Filter accepted by query strings, the TUI, and the model-callable tool. */
export interface UsageFilter {
  /** Inclusive lower bound: epoch ms, ISO date, `YYYY-MM-DD`, or a relative day count as `-7d`. */
  from?: number | string;
  /** Exclusive upper bound: same formats as `from`. */
  to?: number | string;
  /** Convenience: only the last N days (overrides `from`). */
  days?: number;
  /** `provider/model` keys. */
  models?: string[];
  providers?: string[];
  projects?: string[];
  sessionIds?: string[];
  kinds?: UsageKind[];
  /** Cap on bucket rows returned; defaults to 60 days / 25 models / 100 sessions. */
  limit?: number;
}

export interface Bucket {
  key: string;
  label: string;
  usage: UsageTotals;
  requests: number;
  /** Fraction of the bucket dimension's grand total, 0..1 (tokens, not cost). */
  share: number;
}

export interface DayBucket extends Bucket {
  /** `YYYY-MM-DD`, local time. */
  day: string;
}

export interface ModelBucket extends Bucket {
  provider: string;
  model: string;
  sessions: number;
}

export interface ProjectBucket extends Bucket {
  project: string;
  cwd: string;
  sessions: number;
}

export interface SessionBucket extends Bucket {
  sessionId: string;
  sessionName: string;
  cwd: string;
  project: string;
  models: string[];
  startedAt: number;
  lastActivityAt: number;
  messages: number;
}

export interface KindBucket extends Bucket {
  kind: UsageKind;
}

export interface StatsResult {
  generatedAt: number;
  sessionsDir: string;
  filter: AppliedFilter;
  totals: UsageTotals;
  /** All currently available values, useful for building filter controls. */
  facets: {
    models: ModelFacet[];
    providers: string[];
    projects: ProjectFacet[];
    sessions: SessionFacet[];
    kinds: UsageKind[];
    days: string[];
  };
  byDay: DayBucket[];
  byModel: ModelBucket[];
  byProject: ProjectBucket[];
  bySession: SessionBucket[];
  byKind: KindBucket[];
  /** Number of distinct sessions with at least one event in the filtered range. */
  sessionsIncluded: number;
  /** Number of usage events in the filtered range. */
  eventsIncluded: number;
  /** Number of JSONL files inspected. */
  scannedFiles: number;
  /** Sum of all events before filtering (used for "x of y" labels). */
  unfiltered: {
    totals: UsageTotals;
    sessions: number;
    events: number;
  };
  issues: ScanIssue[];
}

export interface AppliedFilter {
  from?: number;
  to?: number;
  days?: number;
  models: string[];
  providers: string[];
  projects: string[];
  sessionIds: string[];
  kinds: UsageKind[];
}

export interface ModelFacet {
  key: string;
  provider: string;
  model: string;
  requests: number;
  totalTokens: number;
}

export interface ProjectFacet {
  project: string;
  cwd: string;
  sessions: number;
  totalTokens: number;
}

export interface SessionFacet {
  id: string;
  name: string;
  project: string;
  lastActivityAt: number;
  totalTokens: number;
}

export interface SessionDetail {
  session: SessionSummary;
  events: UsageEvent[];
  byDay: DayBucket[];
  byModel: ModelBucket[];
  byKind: KindBucket[];
}

export function emptyCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: emptyCost(),
    requests: 0,
  };
}

export function addUsage(target: UsageTotals, source: UsageTotals): UsageTotals {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
  target.requests += source.requests;
  return target;
}
