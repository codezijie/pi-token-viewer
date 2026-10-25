/**
 * Interactive TUI dashboard.
 *
 * One component owns the whole screen: a filter header, a stack of charts or
 * tables, and a key hint bar. It is deliberately dependency-free beyond pi-tui
 * helpers so it can be rendered by a test harness with a stub theme.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { aggregate, KIND_LABELS, sessionDetail } from "../aggregate.ts";
import {
  bar,
  formatCost,
  formatInt,
  formatPercent,
  formatRelative,
  formatTokens,
  shortenPath,
  shortDayLabel,
  sparkline,
  stackedBar,
  truncate,
} from "../format.ts";
import { addUsage, emptyTotals } from "../types.ts";
import type { DayBucket, ScanResult, SessionDetail, StatsResult, UsageFilter, UsageTotals } from "../types.ts";

export interface DashboardDeps {
  scan: ScanResult;
  reload: () => Promise<ScanResult>;
  openWeb: () => Promise<void>;
  exportCsv: () => Promise<string | undefined>;
}

type View = "overview" | "models" | "sessions" | "days" | "session" | "help";
type Metric = "tokens" | "cost";
type SessionSort = "tokens" | "cost" | "recent";

const RANGES: { label: string; days?: number }[] = [
  { label: "All time" },
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

const VIEW_TABS: { view: View; label: string }[] = [
  { view: "overview", label: "Overview" },
  { view: "models", label: "Models" },
  { view: "sessions", label: "Sessions" },
  { view: "days", label: "Days" },
];

const MAX_TABLE_ROWS = 12;

export class TokenDashboard implements Component {
  private scan: ScanResult;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private tui: TUI;
  private deps: DashboardDeps;
  private done: () => void;

  private view: View = "overview";
  private rangeIndex = 0;
  private modelIndex = 0;
  private projectIndex = 0;
  private metric: Metric = "tokens";
  private sessionSort: SessionSort = "tokens";
  private selected = 0;
  private detail?: SessionDetail;
  private loading = false;
  private toast?: { text: string; tone: "info" | "success" | "error" };
  private toastTimer?: ReturnType<typeof setTimeout>;

  private cachedWidth?: number;
  private cachedLines?: string[];
  private statsCache?: StatsResult;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void, deps: DashboardDeps) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.deps = deps;
    this.scan = deps.scan;
  }

  // ---------------------------------------------------------------- input

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.view === "session" || this.view === "help") {
        this.view = this.view === "session" ? "sessions" : "overview";
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.done();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }

    // Arrow keys switch tabs: ←/↑ previous, →/↓ next. Row selection moved to
    // j/k and Shift+↑/↓ so plain arrows stay dedicated to navigation.
    if (matchesKey(data, "left") || matchesKey(data, "up") || data === "h") {
      this.cycleView(-1);
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "down") || data === "l") {
      this.cycleView(1);
      return;
    }

    if (
      data === "k" ||
      matchesKey(data, "shift+up") ||
      (!this.isArrowKey(data) && this.keybindings.matches(data, "tui.select.up"))
    ) {
      this.moveSelection(-1);
      return;
    }
    if (
      data === "j" ||
      matchesKey(data, "shift+down") ||
      (!this.isArrowKey(data) && this.keybindings.matches(data, "tui.select.down"))
    ) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectRow(0);
      return;
    }
    if (matchesKey(data, "end")) {
      this.selectRow(Number.POSITIVE_INFINITY);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-MAX_TABLE_ROWS);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(MAX_TABLE_ROWS);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.view === "sessions") this.openSelectedSession();
      return;
    }

    switch (data) {
      case "q":
        if (this.view === "session" || this.view === "help") {
          this.view = this.view === "session" ? "sessions" : "overview";
          this.invalidate();
          this.tui.requestRender();
          return;
        }
        this.done();
        return;
      case "?":
        this.view = this.view === "help" ? "overview" : "help";
        this.invalidate();
        this.tui.requestRender();
        return;
      case "1":
      case "2":
      case "3":
      case "4": {
        const tab = VIEW_TABS[Number(data) - 1];
        if (tab) {
          this.view = tab.view;
          this.selected = 0;
          this.refreshStats();
        }
        return;
      }
      case "tab":
        this.cycleView(1);
        return;
      case "shift+tab":
        this.cycleView(-1);
        return;
      case "d":
        this.rangeIndex = (this.rangeIndex + 1) % RANGES.length;
        this.selected = 0;
        this.refreshStats();
        return;
      case "D":
        this.rangeIndex = (this.rangeIndex - 1 + RANGES.length) % RANGES.length;
        this.selected = 0;
        this.refreshStats();
        return;
      case "m":
        this.modelIndex = (this.modelIndex + 1) % (this.modelFacets().length + 1);
        this.selected = 0;
        this.refreshStats();
        return;
      case "p":
        this.projectIndex = (this.projectIndex + 1) % (this.projectFacets().length + 1);
        this.selected = 0;
        this.refreshStats();
        return;
      case "c":
        this.metric = this.metric === "tokens" ? "cost" : "tokens";
        this.selected = 0;
        this.refreshStats();
        return;
      case "s":
        this.sessionSort = this.sessionSort === "tokens" ? "cost" : this.sessionSort === "cost" ? "recent" : "tokens";
        this.selected = 0;
        this.refreshStats();
        return;
      case "r":
        void this.reload();
        return;
      case "w":
        void this.openWeb();
        return;
      case "e":
        void this.exportCsv();
        return;
      default:
        return;
    }
  }

  private cycleView(direction: 1 | -1): void {
    const index = VIEW_TABS.findIndex((tab) => tab.view === this.view);
    const base = index < 0 ? 0 : index;
    const next = VIEW_TABS[(base + direction + VIEW_TABS.length) % VIEW_TABS.length];
    if (next) {
      this.view = next.view;
      this.selected = 0;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private isArrowKey(data: string): boolean {
    return (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    );
  }

  private selectRow(index: number): void {
    const rows = this.visibleRowCount();
    if (rows === 0) return;
    this.selected = Math.min(rows - 1, Math.max(0, index));
    this.invalidate();
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const rows = this.visibleRowCount();
    if (rows === 0) return;
    this.selected = Math.min(rows - 1, Math.max(0, this.selected + delta));
    this.invalidate();
    this.tui.requestRender();
  }

  private visibleRowCount(): number {
    switch (this.view) {
      case "sessions":
        return this.sessionRows().length;
      case "models":
        return this.stats().byModel.length;
      case "days":
        return this.stats().byDay.length;
      default:
        return 0;
    }
  }

  private openSelectedSession(): void {
    const rows = this.sessionRows();
    const row = rows[this.selected];
    if (!row) return;
    const detail = sessionDetail(this.scan, row.key);
    if (!detail) {
      this.showToast("Session not found", "error");
      return;
    }
    this.detail = detail;
    this.view = "session";
    this.invalidate();
    this.tui.requestRender();
  }

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.showToast("Rescanning sessions…", "info");
    try {
      this.scan = await this.deps.reload();
      this.statsCache = undefined;
      if (this.detail) {
        const sessionId = this.detail.session.id;
        this.detail = sessionDetail(this.scan, sessionId);
        if (!this.detail && this.view === "session") this.view = "sessions";
      }
      this.showToast(`Loaded ${this.scan.sessions.length} sessions`, "success");
    } catch (error) {
      this.showToast(`Reload failed: ${errorMessage(error)}`, "error");
    } finally {
      this.loading = false;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private async openWeb(): Promise<void> {
    try {
      await this.deps.openWeb();
    } catch (error) {
      this.showToast(`Web dashboard failed: ${errorMessage(error)}`, "error");
    }
  }

  private async exportCsv(): Promise<void> {
    try {
      const file = await this.deps.exportCsv();
      this.showToast(file ? `Exported ${file}` : "Nothing to export", file ? "success" : "info");
    } catch (error) {
      this.showToast(`Export failed: ${errorMessage(error)}`, "error");
    }
  }

  private showToast(text: string, tone: "info" | "success" | "error"): void {
    this.toast = { text, tone };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = undefined;
      this.toastTimer = undefined;
      this.invalidate();
      this.tui.requestRender();
    }, 3000);
    this.invalidate();
    this.tui.requestRender();
  }

  // ---------------------------------------------------------------- state

  private modelFacets() {
    return this.stats().facets.models;
  }

  private projectFacets() {
    return this.stats().facets.projects;
  }

  private stats(): StatsResult {
    if (this.statsCache) return this.statsCache;
    const unfiltered = aggregate(this.scan, {}, Date.now());
    const model = unfiltered.facets.models[Math.max(0, this.modelIndex - 1)];
    const project = unfiltered.facets.projects[Math.max(0, this.projectIndex - 1)];
    const filter: UsageFilter = {};
    const range = RANGES[this.rangeIndex];
    if (range?.days) filter.days = range.days;
    if (this.modelIndex > 0 && model) filter.models = [model.key];
    if (this.projectIndex > 0 && project) filter.projects = [project.project];
    this.statsCache = aggregate(this.scan, filter, Date.now());
    return this.statsCache;
  }

  private refreshStats(): void {
    this.statsCache = undefined;
    // Clamp selections against the newly computed buckets.
    this.stats();
    this.invalidate();
    this.tui.requestRender();
  }

  private sessionRows() {
    const rows = [...this.stats().bySession];
    if (this.sessionSort === "recent") {
      rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    } else if (this.sessionSort === "cost") {
      rows.sort((a, b) => b.usage.cost.total - a.usage.cost.total);
    } else {
      rows.sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
    }
    return rows;
  }

  // ---------------------------------------------------------------- render

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines =
      this.view === "overview"
        ? this.renderOverview(width)
        : this.view === "models"
          ? this.renderModels(width)
          : this.view === "sessions"
            ? this.renderSessions(width)
            : this.view === "days"
              ? this.renderDays(width)
              : this.view === "session"
                ? this.renderSessionDetail(width)
                : this.renderHelp(width);

    const fitted = lines.map((line) => truncateToWidth(line, width));
    this.cachedWidth = width;
    this.cachedLines = fitted;
    return fitted;
  }

  // -- shared chrome ------------------------------------------------------

  private header(width: number): string[] {
    const th = this.theme;
    const stats = this.stats();
    const title = th.bold(th.fg("accent", "Token Viewer"));
    const right = th.fg("muted", `${formatInt(stats.sessionsIncluded)} sessions · ${formatInt(stats.eventsIncluded)} requests`);
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right) - 2);
    return [truncateToWidth(`  ${title}${" ".repeat(gap)}${right}`, width), this.rule(width)];
  }

  private rule(width: number): string {
    return this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
  }

  private filterBar(): string {
    const th = this.theme;
    const range = RANGES[this.rangeIndex]?.label ?? "All time";
    const model = this.modelIndex > 0 ? this.modelFacets()[this.modelIndex - 1]?.key : undefined;
    const project = this.projectIndex > 0 ? this.projectFacets()[this.projectIndex - 1]?.project : undefined;
    const parts = [
      th.fg("muted", "range "),
      th.fg("text", range),
      th.fg("muted", " · model "),
      th.fg("text", model ?? "all"),
      th.fg("muted", " · project "),
      th.fg("text", project ? truncate(shortenPath(project), 24) : "all"),
      th.fg("muted", " · metric "),
      th.fg("text", this.metric),
    ];
    return `  ${parts.join("")}`;
  }

  private tabs(): string {
    const th = this.theme;
    const active = this.view === "session" ? "sessions" : this.view === "help" ? "overview" : this.view;
    return `  ${VIEW_TABS.map((tab) => {
      const index = VIEW_TABS.indexOf(tab) + 1;
      const label = `${index} ${tab.label}`;
      return tab.view === active
        ? th.style(` ${label} `, { fg: "accent", bg: "selectedBg", bold: true })
        : th.fg("dim", ` ${label} `);
    }).join(th.fg("borderMuted", "│"))}`;
  }

  private footer(width: number): string[] {
    const th = this.theme;
    const hints =
      this.view === "session"
        ? "esc back · ←→ tabs · w web · e export · r refresh · q quit"
        : this.view === "sessions"
          ? "←→ tabs · j/k select · enter open · d range · m model · c metric · s sort · ? help · q quit"
          : "←→ tabs · d range · m model · c metric · w web · ? help · q quit";
    const lines = [this.rule(width), truncateToWidth(`${th.fg("dim", `  ${this.loading ? "⏳ " : ""}${hints}`)}`, width)];
    if (this.toast) {
      const color = this.toast.tone === "error" ? "error" : this.toast.tone === "success" ? "success" : "muted";
      lines.push(truncateToWidth(`  ${th.fg(color, this.toast.text)}`, width));
    }
    return lines;
  }

  private kpiRow(totals: UsageTotals): string {
    const th = this.theme;
    const cache = totals.cacheRead + totals.cacheWrite;
    const cachedShare = totals.input + cache > 0 ? cache / (totals.input + cache) : 0;
    const cells = [
      `${th.fg("muted", "Tokens ")}${th.bold(th.fg("accent", formatTokens(totals.totalTokens)))}`,
      `${th.fg("muted", "Cost ")}${th.bold(th.fg("warning", formatCost(totals.cost.total)))}`,
      `${th.fg("muted", "Requests ")}${th.fg("text", formatInt(totals.requests))}`,
      `${th.fg("muted", "Cached ")}${th.fg("success", formatPercent(cachedShare))}`,
      `${th.fg("muted", "Avg/req ")}${th.fg("text", formatTokens(totals.requests ? totals.totalTokens / totals.requests : 0))}`,
    ];
    return `  ${cells.join(th.fg("borderMuted", "   "))}`;
  }

  private breakdown(totals: UsageTotals, width: number): string[] {
    const th = this.theme;
    const segments = [
      { value: totals.input, char: th.fg("accent", "█") },
      { value: totals.output, char: th.fg("success", "█") },
      { value: totals.cacheRead + totals.cacheWrite, char: th.fg("thinkingText", "█") },
    ];
    const barWidth = Math.max(12, Math.min(40, width - 60));
    const legend = [
      `${th.fg("accent", "█")} ${th.fg("muted", "input")} ${formatTokens(totals.input)}`,
      `${th.fg("success", "█")} ${th.fg("muted", "output")} ${formatTokens(totals.output)}`,
      `${th.fg("thinkingText", "█")} ${th.fg("muted", "cache")} ${formatTokens(totals.cacheRead + totals.cacheWrite)}`,
    ];
    return [`  ${stackedBar(segments, barWidth)}  ${legend.join(th.fg("borderMuted", "  "))}`];
  }

  // -- overview -----------------------------------------------------------

  private renderOverview(width: number): string[] {
    const th = this.theme;
    const stats = this.stats();
    const lines: string[] = [];

    lines.push(...this.header(width));
    lines.push("");
    lines.push(truncateToWidth(this.kpiRow(stats.totals), width));
    lines.push("");
    lines.push(truncateToWidth(this.breakdown(stats.totals, width).join(""), width));
    lines.push("");
    lines.push(truncateToWidth(this.filterBar(), width));
    lines.push(truncateToWidth(this.tabs(), width));
    lines.push("");

    const days = overviewSeries(stats.byDay, 14);
    const maxDay = Math.max(1, ...days.map((day) => this.metric === "cost" ? day.usage.cost.total : day.usage.totalTokens));
    const spark = sparkline(stats.byDay.slice(-30).map((day) => this.metric === "cost" ? day.usage.cost.total : day.usage.totalTokens), 30);
    const truncated = stats.byDay.length >= 60 && !stats.filter.from && stats.filter.to === undefined;
    lines.push(
      `  ${th.fg("muted", `Daily ${this.metric}${truncated ? " (last 60 days)" : ""} `)}${th.fg("accent", spark)}`,
    );
    const chartWidth = Math.max(8, Math.min(28, width - 48));
    for (const day of days) {
      const value = this.metric === "cost" ? day.usage.cost.total : day.usage.totalTokens;
      const rendered = this.metric === "cost" ? formatCost(value) : formatTokens(value);
      const bars = bar(value, maxDay, chartWidth, th.fg("accent", "█"), th.fg("borderMuted", "░"));
      lines.push(
        `  ${th.fg("muted", pad(shortDayLabel(day.day), 7))} ${bars} ${th.fg("text", padStart(rendered, 6))} ${th.fg("dim", padStart(formatCost(day.usage.cost.total), 8))}`,
      );
    }
    lines.push("");

    const topModels = stats.byModel.slice(0, 4);
    if (topModels.length > 0) {
      lines.push(`  ${th.fg("muted", "Top models")}`);
      const modelBarWidth = Math.max(6, Math.min(20, width - 56));
      const maxModel = Math.max(1, ...topModels.map((model) => this.metric === "cost" ? model.usage.cost.total : model.usage.totalTokens));
      for (const model of topModels) {
        const value = this.metric === "cost" ? model.usage.cost.total : model.usage.totalTokens;
        lines.push(
          `  ${th.fg("text", pad(truncate(model.key, 30), 30))} ${bar(value, maxModel, modelBarWidth, th.fg("success", "█"), th.fg("borderMuted", "░"))} ${th.fg("muted", padStart(this.metric === "cost" ? formatCost(value) : formatTokens(value), 7))} ${th.fg("dim", padStart(formatCost(model.usage.cost.total), 8))}`,
        );
      }
      lines.push("");
    }

    if (stats.byKind.length > 1) {
      lines.push(
        `  ${th.fg("muted", "By kind")}  ${stats.byKind
          .map((kind) => `${th.fg("text", KIND_LABELS[kind.kind])} ${th.fg("muted", formatTokens(kind.usage.totalTokens))}`)
          .join(th.fg("borderMuted", " · "))}`,
      );
    }

    lines.push(...this.footer(width));
    return lines;
  }

  // -- models -------------------------------------------------------------

  private renderModels(width: number): string[] {
    const th = this.theme;
    const stats = this.stats();
    const lines: string[] = [];
    lines.push(...this.header(width));
    lines.push(truncateToWidth(this.filterBar(), width));
    lines.push(truncateToWidth(this.tabs(), width));
    lines.push("");

    const rows = stats.byModel.slice(0, MAX_TABLE_ROWS);
    const max = Math.max(1, ...rows.map((row) => this.metric === "cost" ? row.usage.cost.total : row.usage.totalTokens));
    const nameWidth = Math.max(12, Math.min(34, width - 62));
    const barWidth = Math.max(6, Math.min(18, width - nameWidth - 44));
    lines.push(
      `  ${th.fg("muted", pad("Model", nameWidth))} ${th.fg("muted", pad("Provider", 12))} ${th.fg("muted", padStart("Reqs", 6))} ${th.fg("muted", padStart("Tokens", 8))} ${th.fg("muted", padStart("Cost", 9))} ${th.fg("muted", padStart("Share", 6))}  ${th.fg("muted", "")}`,
    );
    rows.forEach((row, index) => {
      const value = this.metric === "cost" ? row.usage.cost.total : row.usage.totalTokens;
      const cells = `  ${pad(truncate(row.model, nameWidth), nameWidth)} ${th.fg("muted", pad(truncate(row.provider, 12), 12))} ${padStart(formatInt(row.requests), 6)} ${th.fg("accent", padStart(formatTokens(row.usage.totalTokens), 8))} ${th.fg("warning", padStart(formatCost(row.usage.cost.total), 9))} ${th.fg("muted", padStart(formatPercent(row.share), 6))}  ${bar(value, max, barWidth, th.fg("accent", "█"), th.fg("borderMuted", "░"))}`;
      lines.push(this.selectable(cells, index === this.selected));
    });
    if (rows.length === 0) lines.push(`  ${th.fg("dim", "No usage matches the current filters.")}`);

    lines.push("");
    lines.push(
      `  ${th.fg("dim", `${rows.length} of ${stats.byModel.length} models · sessions: ${formatInt(stats.sessionsIncluded)} · requests: ${formatInt(stats.totals.requests)}`)}`,
    );
    lines.push(...this.footer(width));
    return lines;
  }

  // -- sessions -----------------------------------------------------------

  private renderSessions(width: number): string[] {
    const th = this.theme;
    const stats = this.stats();
    const rows = this.sessionRows();
    const lines: string[] = [];
    lines.push(...this.header(width));
    lines.push(truncateToWidth(this.filterBar(), width));
    lines.push(truncateToWidth(this.tabs(), width));
    lines.push("");

    const visible = rows.slice(0, MAX_TABLE_ROWS);
    const nameWidth = Math.max(10, Math.min(26, Math.floor((width - 50) * 0.45)));
    const projectWidth = Math.max(8, Math.min(24, width - 50 - nameWidth));
    lines.push(
      `  ${th.fg("muted", pad("Session", nameWidth))} ${th.fg("muted", pad("Project", projectWidth))} ${th.fg("muted", padStart("Last", 10))} ${th.fg("muted", padStart("Reqs", 6))} ${th.fg("muted", padStart("Tokens", 8))} ${th.fg("muted", padStart("Cost", 9))} ${th.fg("muted", padStart("Share", 6))}`,
    );
    visible.forEach((row, index) => {
      const last = row.lastActivityAt ? formatRelative(row.lastActivityAt) : "—";
      const cells = `  ${pad(truncate(row.sessionName, nameWidth), nameWidth)} ${th.fg("muted", pad(truncate(shortenPath(row.project), projectWidth), projectWidth))} ${th.fg("dim", padStart(last, 10))} ${padStart(formatInt(row.requests), 6)} ${th.fg("accent", padStart(formatTokens(row.usage.totalTokens), 8))} ${th.fg("warning", padStart(formatCost(row.usage.cost.total), 9))} ${th.fg("muted", padStart(formatPercent(row.share), 6))}`;
      lines.push(this.selectable(cells, index === this.selected));
    });
    if (visible.length === 0) lines.push(`  ${th.fg("dim", "No sessions match the current filters.")}`);

    const hidden = rows.length - visible.length;
    lines.push("");
    lines.push(
      `  ${th.fg("dim", `sorted by ${this.sessionSort} · ${rows.length} sessions${hidden > 0 ? ` (${hidden} more below)` : ""} · ${formatCost(stats.totals.cost.total)} total`)}${this.selected < rows.length ? `  ${th.fg("muted", `selected: ${truncate(rows[this.selected]?.sessionName ?? "", 28)}`)}` : ""}`,
    );
    lines.push(...this.footer(width));
    return lines;
  }

  // -- days ---------------------------------------------------------------

  private renderDays(width: number): string[] {
    const th = this.theme;
    const stats = this.stats();
    const lines: string[] = [];
    lines.push(...this.header(width));
    lines.push(truncateToWidth(this.filterBar(), width));
    lines.push(truncateToWidth(this.tabs(), width));
    lines.push("");

    const rows = stats.byDay.slice(-MAX_TABLE_ROWS);
    const max = Math.max(1, ...rows.map((row) => this.metric === "cost" ? row.usage.cost.total : row.usage.totalTokens));
    const barWidth = Math.max(8, Math.min(24, width - 64));
    lines.push(
      `  ${th.fg("muted", pad("Day", 10))} ${th.fg("muted", padStart("Reqs", 6))} ${th.fg("muted", padStart("Input", 8))} ${th.fg("muted", padStart("Output", 8))} ${th.fg("muted", padStart("Cache", 8))} ${th.fg("muted", padStart("Total", 8))} ${th.fg("muted", padStart("Cost", 9))}`,
    );
    rows.forEach((row, index) => {
      const usage = row.usage;
      const value = this.metric === "cost" ? usage.cost.total : usage.totalTokens;
      const cells = `  ${pad(shortDayLabel(row.day), 10)} ${padStart(formatInt(row.requests), 6)} ${padStart(formatTokens(usage.input), 8)} ${padStart(formatTokens(usage.output), 8)} ${padStart(formatTokens(usage.cacheRead + usage.cacheWrite), 8)} ${th.fg("accent", padStart(formatTokens(usage.totalTokens), 8))} ${th.fg("warning", padStart(formatCost(usage.cost.total), 9))}  ${bar(value, max, barWidth, th.fg("accent", "█"), th.fg("borderMuted", "░"))}`;
      lines.push(cells);
    });
    if (rows.length === 0) lines.push(`  ${th.fg("dim", "No daily usage matches the current filters.")}`);

    lines.push("");
    lines.push(
      `  ${th.fg("dim", `${rows.length} days shown · avg ${formatTokens(stats.totals.totalTokens / Math.max(1, rows.length))} tokens/day · ${formatCost(stats.totals.cost.total / Math.max(1, rows.length))}/day`)}`,
    );
    lines.push(...this.footer(width));
    return lines;
  }

  // -- session detail -----------------------------------------------------

  private renderSessionDetail(width: number): string[] {
    const th = this.theme;
    const detail = this.detail;
    const lines: string[] = [];
    if (!detail) {
      lines.push(...this.header(width));
      lines.push(`  ${th.fg("dim", "No session selected.")}`);
      lines.push(...this.footer(width));
      return lines;
    }
    const session = detail.session;
    const usage = session.usage;

    lines.push(...this.header(width));
    lines.push(
      `  ${th.bold(th.fg("text", session.name))}  ${th.fg("dim", session.id)}${session.parentSession ? th.fg("dim", " · forked") : ""}`,
    );
    lines.push(`  ${th.fg("muted", "Project ")}${th.fg("text", shortenPath(session.project || "unknown"))}`);
    lines.push(
      `  ${th.fg("muted", "Span ")}${th.fg("text", session.startedAt ? formatRelative(session.startedAt) : "—")} ${th.fg("dim", "→")} ${th.fg("text", session.lastActivityAt ? formatRelative(session.lastActivityAt) : "—")}   ${th.fg("muted", "Messages ")}${th.fg("text", formatInt(session.messageCount))} ${th.fg("dim", `(${formatInt(session.userMessages)} user · ${formatInt(session.toolCalls)} tool calls)`)}`,
    );
    lines.push("");
    lines.push(truncateToWidth(this.kpiRow(usage), width));
    lines.push("");
    lines.push(...this.breakdown(usage, width).map((line) => truncateToWidth(line, width)));
    lines.push("");
    lines.push(
      `  ${th.fg("muted", "Models ")}${detail.byModel
        .map((model) => `${th.fg("text", model.key)} ${th.fg("dim", `${formatTokens(model.usage.totalTokens)} · ${formatCost(model.usage.cost.total)}`)}`)
        .join(th.fg("borderMuted", "  ·  "))}`,
    );
    if (detail.byKind.length > 0) {
      lines.push(
        `  ${th.fg("muted", "Kinds  ")}${detail.byKind
          .map((kind) => `${th.fg("text", KIND_LABELS[kind.kind])} ${th.fg("dim", formatTokens(kind.usage.totalTokens))}`)
          .join(th.fg("borderMuted", " · "))}`,
      );
    }
    lines.push("");
    lines.push(`  ${th.fg("muted", "Recent requests")}`);
    const recent = detail.events.slice(-10).reverse();
    const nameWidth = Math.max(14, Math.min(34, width - 52));
    for (const event of recent) {
      const kind = event.kind === "assistant" ? (event.toolName ? `tool:${event.toolName}` : "assistant") : KIND_LABELS[event.kind];
      lines.push(
        `  ${th.fg("dim", formatRelative(event.timestamp))} ${th.fg("text", padStart(formatTokens(event.usage.totalTokens), 7))} ${th.fg("warning", padStart(formatCost(event.usage.cost.total), 8))} ${th.fg("muted", pad(truncate(kind, 18), 18))} ${th.fg("accent", pad(truncate(event.model, nameWidth), nameWidth))} ${th.fg("dim", `in ${formatTokens(event.usage.input)} · out ${formatTokens(event.usage.output)} · cache ${formatTokens(event.usage.cacheRead)}`)}`,
      );
    }
    if (recent.length === 0) lines.push(`  ${th.fg("dim", "No usage events recorded.")}`);
    lines.push(...this.footer(width));
    return lines;
  }

  // -- help ---------------------------------------------------------------

  private renderHelp(width: number): string[] {
    const th = this.theme;
    const rows: [string, string][] = [
      ["← → / ↑ ↓", "Previous / next tab (wraps around)"],
      ["tab / shift+tab", "Previous / next tab"],
      ["1 2 3 4", "Jump to a view"],
      ["j / k", "Move the row selection"],
      ["shift+↑ / ↓", "Move the row selection"],
      ["home / end", "First / last row"],
      ["enter", "Open the selected session"],
      ["esc / q", "Go back, then close the dashboard"],
      ["d / shift+d", "Next / previous date range"],
      ["m", "Cycle model filter (all models → one model)"],
      ["p", "Cycle project filter"],
      ["c", "Toggle metric between tokens and cost"],
      ["s", "Cycle session sort (tokens, cost, recent)"],
      ["r", "Rescan session files"],
      ["w", "Open the web dashboard in a browser"],
      ["e", "Export every usage event to CSV"],
    ];
    const lines: string[] = [];
    lines.push(...this.header(width));
    lines.push(`  ${th.bold(th.fg("accent", "Keyboard shortcuts"))}`);
    lines.push("");
    const keyWidth = Math.min(20, Math.max(12, ...rows.map(([key]) => key.length + 2)));
    for (const [key, description] of rows) {
      lines.push(`  ${th.fg("accent", pad(key, keyWidth))} ${th.fg("text", description)}`);
    }
    lines.push("");
    lines.push(`  ${th.fg("muted", "Notes")}`);
    lines.push(`  ${th.fg("dim", "· Every branch of every session is counted: discarded work still costs money.")}`);
    lines.push(`  ${th.fg("dim", "· Data is read directly from pi's JSONL session files; nothing leaves your machine.")}`);
    lines.push(`  ${th.fg("dim", "· The web dashboard supports the same filters plus light/dark themes.")}`);
    lines.push(`  ${th.fg("dim", "· Press ? again to return.")}`);
    lines.push(...this.footer(width));
    return lines;
  }

  // -- small helpers ------------------------------------------------------

  private selectable(text: string, selected: boolean): string {
    if (!selected) return truncateToWidth(text, 1000);
    return this.theme.bg("selectedBg", text);
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? truncate(text, width) : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text.slice(-width) : " ".repeat(width - text.length) + text;
}

/**
 * Overview chart data: daily buckets up to 14 bars. Longer ranges are aggregated
 * into equal-width groups so early activity is not dropped from the window.
 */
function overviewSeries(days: DayBucket[], maxBars: number): DayBucket[] {
  if (days.length <= maxBars) return days;
  const size = Math.ceil(days.length / maxBars);
  const out: DayBucket[] = [];
  for (let i = 0; i < days.length; i += size) {
    const group = days.slice(i, i + size);
    const usage = emptyTotals();
    for (const day of group) addUsage(usage, day.usage);
    out.push({
      key: group[0]!.day,
      day: group[0]!.day,
      label: group[0]!.day,
      usage,
      requests: usage.requests,
      share: group.reduce((sum, day) => sum + day.share, 0),
    });
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
