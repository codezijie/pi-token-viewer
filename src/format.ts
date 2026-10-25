/** Formatting helpers shared by the TUI and the browser. */

const HOME = (() => {
  try {
    return process.env.HOME || process.env.USERPROFILE || "";
  } catch {
    return "";
  }
})();

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(0)}`;
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (delta < 0) return "just now";
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return formatDate(timestamp);
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(timestamp: number): string {
  return `${formatDate(timestamp)} ${formatTime(timestamp)}`;
}

/** `2026-10-25` -> `Oct 25` (uses the current year only when different). */
export function shortDayLabel(day: string, now = Date.now()): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return day;
  const [, y, m, d] = parts as unknown as [string, string, string, string];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m) - 1] ?? m;
  const currentYear = new Date(now).getFullYear();
  return Number(y) === currentYear ? `${month} ${Number(d)}` : `${month} ${Number(d)}, ${y.slice(2)}`;
}

/** Shorten a cwd for narrow terminals: `/home/me/code/x` -> `~/code/x`. */
export function shortenPath(value: string): string {
  if (!value) return "unknown";
  if (HOME && value.startsWith(HOME)) return `~${value.slice(HOME.length)}`;
  return value;
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

export function padEnd(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
  if (text.length >= width) return text.slice(-width);
  return " ".repeat(width - text.length) + text;
}

/** Unicode sparkline from a value series. */
export function sparkline(values: number[], width = 24): string {
  if (values.length === 0) return " ".repeat(width);
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...values);
  const series = values.length > width ? downsample(values, width) : values;
  if (max <= 0) return blocks[0]!.repeat(series.length);
  return series.map((value) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.round((value / max) * (blocks.length - 1))))]!).join("");
}

function downsample(values: number[], width: number): number[] {
  const size = Math.ceil(values.length / width);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(Math.max(...values.slice(i, i + size)));
  }
  return out.slice(0, width);
}

/** Filled/empty bar of exactly `width` cells. */
export function bar(value: number, max: number, width: number, filled = "█", empty = "░"): string {
  if (width <= 0) return "";
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const cells = Math.round(ratio * width);
  return filled.repeat(cells) + empty.repeat(Math.max(0, width - cells));
}

/** A horizontal stacked bar showing input/output/cache proportions. */
export function stackedBar(parts: { value: number; char: string }[], width: number): string {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total <= 0 || width <= 0) return "░".repeat(width);
  let remaining = width;
  const chars: string[] = [];
  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    const cells = isLast ? remaining : Math.round((part.value / total) * width);
    const clamped = Math.min(remaining, Math.max(0, cells));
    chars.push(part.char.repeat(clamped));
    remaining -= clamped;
  });
  if (remaining > 0) chars.push("░".repeat(remaining));
  return chars.join("");
}

/** Human-friendly "in 1.2k · out 300 · cache 8.1k" summary. */
export function describeUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}): string {
  return `in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)} · cache ${formatTokens(
    usage.cacheRead + usage.cacheWrite,
  )} · ${formatTokens(usage.totalTokens)} tokens · ${formatCost(usage.cost.total)}`;
}
