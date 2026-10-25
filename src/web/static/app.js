/* pi token viewer — browser client. No dependencies, no build step. */
(() => {
  "use strict";

  const body = document.body;
  const TOKEN = body.dataset.token || "";
  const DIRS = body.dataset.dirs || "";

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const state = {
    range: "all",
    from: "",
    to: "",
    models: new Set(),
    project: "",
    session: "",
    metric: "tokens",
    search: "",
  };

  let latest = null;
  let drawerSessionId = null;
  let fetchSeq = 0;
  let refreshTimer = null;
  let lastFetchAt = 0;
  let pollTimer = null;

  // ------------------------------------------------------------- formatting

  function fmtTokens(value) {
    if (!Number.isFinite(value)) return "0";
    const abs = Math.abs(value);
    if (abs >= 1e9) return trim(value / 1e9) + "B";
    if (abs >= 1e6) return trim(value / 1e6) + "M";
    if (abs >= 1e3) return trim(value / 1e3) + "k";
    return String(Math.round(value));
  }
  function trim(v) {
    if (v >= 100) return v.toFixed(0);
    if (v >= 10) return v.toFixed(1).replace(/\.0$/, "");
    return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  function fmtCost(value) {
    if (!Number.isFinite(value) || value === 0) return "$0.00";
    if (value < 0.01) return "$" + value.toFixed(4);
    if (value < 100) return "$" + value.toFixed(2);
    return "$" + value.toFixed(0);
  }
  function fmtInt(value) {
    return Math.round(value || 0).toLocaleString("en-US");
  }
  function fmtPct(value, digits = 0) {
    if (!Number.isFinite(value)) return "0%";
    return (value * 100).toFixed(digits) + "%";
  }
  function shortDay(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    if (!m) return day || "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const suffix = Number(m[1]) === now.getFullYear() ? "" : ", " + m[1].slice(2);
    return months[Number(m[2]) - 1] + " " + Number(m[3]) + suffix;
  }
  function relTime(ts) {
    if (!ts) return "—";
    const delta = Date.now() - ts;
    if (delta < 60e3) return "just now";
    if (delta < 36e5) return Math.floor(delta / 6e4) + "m ago";
    if (delta < 864e5) return Math.floor(delta / 36e5) + "h ago";
    if (delta < 7 * 864e5) return Math.floor(delta / 864e5) + "d ago";
    return shortDay(new Date(ts).toISOString().slice(0, 10));
  }
  function basename(path) {
    if (!path) return "unknown";
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || path;
  }
  function metricValue(usage) {
    return state.metric === "cost" ? usage.cost.total : usage.totalTokens;
  }
  function formatMetric(usage) {
    return state.metric === "cost" ? fmtCost(usage.cost.total) : fmtTokens(usage.totalTokens);
  }

  // ------------------------------------------------------------------ theme

  const THEMES = ["auto", "light", "dark"];
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("pi-token-viewer-theme", theme);
    } catch (_) {
      /* private mode */
    }
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      const active = btn.dataset.themeChoice === theme;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") || "auto";
  }
  function cycleTheme() {
    applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
  }

  // -------------------------------------------------------------------- api

  function filterParams() {
    const params = new URLSearchParams();
    if (state.from || state.to) {
      if (state.from) params.set("from", state.from);
      if (state.to) params.set("to", state.to);
    } else if (state.range !== "all") {
      params.set("range", state.range);
    }
    if (state.models.size) params.set("models", [...state.models].join(","));
    if (state.project) params.set("project", state.project);
    if (state.session) params.set("session", state.session);
    return params;
  }

  async function api(path, params) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("token", TOKEN);
    if (params) params.forEach((value, key) => url.searchParams.append(key, value));
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(response.status + " " + (text || response.statusText));
    }
    return response.json();
  }

  async function loadStats({ quiet = false, force = false } = {}) {
    const seq = ++fetchSeq;
    if (!quiet) setBusy(true);
    try {
      const params = filterParams();
      if (force) params.set("refresh", "1");
      const data = await api("/api/stats", params);
      if (seq !== fetchSeq) return;
      latest = data;
      renderAll(data);
      lastFetchAt = Date.now();
      hideError();
      if (!quiet) setBusy(false);
    } catch (error) {
      if (seq !== fetchSeq) return;
      setBusy(false);
      showError(error);
    }
  }

  function queueFetch(quiet = true) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      loadStats({ quiet });
    }, 450);
  }

  function setBusy(busy) {
    const btn = $("refreshBtn");
    if (btn) {
      btn.disabled = busy;
      btn.querySelector("span").textContent = busy ? "Refreshing" : "Refresh";
    }
  }

  // ------------------------------------------------------------------ toast

  let toastTimer = null;
  function toast(message, isError = false) {
    const node = $("toast");
    node.textContent = message;
    node.classList.toggle("err", isError);
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
      toastTimer = null;
    }, 3200);
  }

  function showError(error) {
    const message = error && error.message ? error.message : String(error);
    toast("Could not load usage data: " + message, true);
    const chart = $("chart");
    if (chart && !chart.dataset.rendered) {
      chart.innerHTML = '<p class="empty-state">Unable to load data. Is the pi session directory readable?</p>';
    }
  }
  function hideError() {
    const chart = $("chart");
    if (chart) delete chart.dataset.rendered;
  }

  // ----------------------------------------------------------------- render

  function renderAll(data) {
    renderFilterControls(data);
    renderKpis(data);
    renderChart($("chart"), data.byDay, { height: 250, tooltip: $("chartTooltip") });
    $("chartHint").textContent = rangeLabel(data);
    renderKindList(data.byKind);
    renderModelTable(data);
    renderSessionTable(data);
    renderProjectList(data.byProject);
    renderMeta(data);
  }

  function renderFilterControls(data) {
    const chipBox = $("modelChips");
    chipBox.replaceChildren();
    if (!data.facets.models.length) {
      chipBox.append(el("span", "chip placeholder", "no models yet"));
    }
    const visibleModels = data.facets.models.slice(0, 12);
    data.facets.models.forEach((model) => {
      if (state.models.has(model.key) && !visibleModels.includes(model)) visibleModels.push(model);
    });
    visibleModels.forEach((model) => {
      const chip = el("button", "chip", null);
      chip.type = "button";
      chip.dataset.model = model.key;
      chip.title = model.key + " · " + fmtInt(model.requests) + " requests · " + fmtTokens(model.totalTokens) + " tokens";
      const label = el("span", null, model.key);
      chip.append(label, el("span", "cost", fmtTokens(model.totalTokens)));
      const active = state.models.has(model.key);
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
      chip.addEventListener("click", () => {
        if (state.models.has(model.key)) state.models.delete(model.key);
        else state.models.add(model.key);
        loadStats();
      });
      chipBox.append(chip);
    });

    const select = $("projectSelect");
    const previous = state.project;
    select.replaceChildren(el("option", null, "All projects"));
    select.firstChild.value = "";
    data.facets.projects.forEach((project) => {
      const option = el("option", null, basename(project.project) + " · " + project.sessions + " sessions");
      option.value = project.project;
      option.title = project.project;
      select.append(option);
    });
    if (state.project) select.value = state.project;
    else if (previous && !data.facets.projects.some((p) => p.project === previous)) state.project = "";
    select.onchange = () => {
      state.project = select.value;
      state.session = "";
      loadStats();
    };

    document.querySelectorAll("#rangeGroup button").forEach((btn) => {
      const active = !state.from && !state.to && btn.dataset.range === state.range;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    $("fromInput").value = state.from;
    $("toInput").value = state.to;
    document.querySelectorAll("#metricGroup button").forEach((btn) => {
      const active = btn.dataset.metric === state.metric;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    $("clearSession").hidden = !state.session;
    $("clearSession").textContent = "Clear session focus · " + shortId(state.session);
  }

  function rangeLabel(data) {
    const filter = data.filter || {};
    if (filter.days) return "last " + filter.days + (filter.days === 1 ? " day" : " days");
    if (filter.from || filter.to) {
      const from = filter.from ? new Date(filter.from).toISOString().slice(0, 10) : "…";
      const to = filter.to ? new Date(filter.to).toISOString().slice(0, 10) : "…";
      return from + " → " + to;
    }
    return data.byDay.length + " days · all time";
  }

  function shortId(id) {
    return id ? id.slice(0, 8) : "";
  }

  function renderKpis(data) {
    const t = data.totals;
    $("kpiTokens").textContent = fmtTokens(t.totalTokens);
    $("kpiTokensSub").textContent =
      "in " + fmtTokens(t.input) + " · out " + fmtTokens(t.output) + " · cache " + fmtTokens(t.cacheRead + t.cacheWrite);

    $("kpiCost").textContent = fmtCost(t.cost.total);
    const blended = t.totalTokens > 0 ? (t.cost.total / t.totalTokens) * 1e6 : 0;
    $("kpiCostSub").textContent = fmtCost(blended) + " per 1M tokens";

    $("kpiRequests").textContent = fmtInt(t.requests);
    $("kpiRequestsSub").textContent =
      data.unfiltered.events !== data.eventsIncluded
        ? data.eventsIncluded + " of " + fmtInt(data.unfiltered.events) + " events"
        : fmtInt(t.requests) + " billable events";

    $("kpiSessions").textContent = fmtInt(data.sessionsIncluded);
    $("kpiSessionsSub").textContent =
      data.unfiltered.sessions !== data.sessionsIncluded
        ? "of " + fmtInt(data.unfiltered.sessions) + " scanned"
        : "across " + fmtInt(data.scannedFiles) + " session files";

    const cache = t.cacheRead + t.cacheWrite;
    const hit = t.input + cache > 0 ? cache / (t.input + cache) : 0;
    $("kpiCache").textContent = fmtPct(hit);
    $("kpiCacheSub").textContent = fmtTokens(t.cacheRead) + " read · " + fmtTokens(t.cacheWrite) + " written";

    $("kpiAvg").textContent = fmtTokens(t.requests ? t.totalTokens / t.requests : 0);
    $("kpiAvgSub").textContent = "tokens · " + fmtCost(t.requests ? t.cost.total / t.requests : 0) + " each";
  }

  // ------------------------------------------------------------------ chart

  function renderChart(container, days, options = {}) {
    const height = options.height || 250;
    const tooltip = options.tooltip;
    const width = Math.max(320, container.clientWidth || 640);
    const padding = { top: 14, right: 10, bottom: 26, left: 52 };
    const plotW = Math.max(10, width - padding.left - padding.right);
    const plotH = height - padding.top - padding.bottom;

    if (!days || days.length === 0) {
      container.replaceChildren(el("p", "empty-state", "No usage in this range."));
      return;
    }

    function segments(day) {
      const u = day.usage;
      if (state.metric === "cost") {
        return [u.cost.input, u.cost.output, u.cost.cacheRead + u.cost.cacheWrite];
      }
      return [u.input, u.output, u.cacheRead + u.cacheWrite];
    }
    const stacks = days.map(segments);
    const max = Math.max(1, ...stacks.map((s) => s[0] + s[1] + s[2]));
    const tickCount = 4;
    const niceMax = niceCeil(max);

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Daily usage chart");

    for (let i = 0; i <= tickCount; i++) {
      const y = padding.top + plotH - (plotH * i) / tickCount;
      const line = document.createElementNS(svgNs, "line");
      line.setAttribute("x1", padding.left);
      line.setAttribute("x2", width - padding.right);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("class", "grid-line");
      svg.append(line);
      const text = document.createElementNS(svgNs, "text");
      text.setAttribute("x", padding.left - 9);
      text.setAttribute("y", y + 3.5);
      text.setAttribute("text-anchor", "end");
      text.setAttribute("class", "axis-text");
      const value = (niceMax * i) / tickCount;
      text.textContent = state.metric === "cost" ? fmtCost(value) : fmtTokens(value);
      svg.append(text);
    }

    const slot = plotW / days.length;
    const barW = Math.max(2, Math.min(46, slot * 0.68));
    const classes = ["bar-input", "bar-output", "bar-cache"];

    days.forEach((day, index) => {
      const x = padding.left + slot * index + (slot - barW) / 2;
      const group = document.createElementNS(svgNs, "g");
      group.setAttribute("class", "bar-group");
      group.dataset.index = String(index);

      const parts = stacks[index];
      const total = parts[0] + parts[1] + parts[2];
      let cursor = padding.top + plotH;
      parts.forEach((value, partIndex) => {
        if (value <= 0) return;
        const h = (value / niceMax) * plotH;
        const rect = document.createElementNS(svgNs, "rect");
        rect.setAttribute("x", x);
        rect.setAttribute("y", cursor - h);
        rect.setAttribute("width", barW);
        rect.setAttribute("height", Math.max(0.6, h));
        rect.setAttribute("rx", Math.min(3, barW / 3));
        rect.setAttribute("class", classes[partIndex]);
        group.append(rect);
        cursor -= h;
      });

      const hit = document.createElementNS(svgNs, "rect");
      hit.setAttribute("x", padding.left + slot * index);
      hit.setAttribute("y", padding.top);
      hit.setAttribute("width", slot);
      hit.setAttribute("height", plotH);
      hit.setAttribute("class", "bar-hit");
      group.append(hit);

      group.dataset.total = String(total);
      svg.append(group);

      const labelStep = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 78))));
      if ((days.length - 1 - index) % labelStep === 0) {
        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", padding.left + slot * index + slot / 2);
        label.setAttribute("y", height - 8);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "axis-text");
        label.textContent = shortDay(day.day);
        svg.append(label);
      }
    });

    container.replaceChildren(svg);
    container.dataset.rendered = "1";

    if (tooltip) {
      const wrap = container.parentElement;
      const move = (event) => {
        const group = event.target.closest && event.target.closest(".bar-group");
        if (!group) {
          tooltip.hidden = true;
          return;
        }
        const day = days[Number(group.dataset.index)];
        if (!day) return;
        const u = day.usage;
        tooltip.replaceChildren();
        tooltip.append(el("div", "tt-day", day.day));
        const rows = [
          ["input", state.metric === "cost" ? fmtCost(u.cost.input) : fmtTokens(u.input)],
          ["output", state.metric === "cost" ? fmtCost(u.cost.output) : fmtTokens(u.output)],
          ["cache", state.metric === "cost" ? fmtCost(u.cost.cacheRead + u.cost.cacheWrite) : fmtTokens(u.cacheRead + u.cacheWrite)],
          ["total", state.metric === "cost" ? fmtCost(u.cost.total) : fmtTokens(u.totalTokens)],
          ["cost", fmtCost(u.cost.total)],
          ["requests", fmtInt(u.requests)],
        ];
        rows.forEach(([label, value]) => {
          const row = el("div", "tt-row");
          row.append(el("span", null, label), el("b", null, value));
          tooltip.append(row);
        });
        const rect = wrap.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        tooltip.style.left = Math.max(90, Math.min(rect.width - 90, x)) + "px";
        tooltip.style.top = Math.max(60, y - 12) + "px";
        tooltip.hidden = false;
      };
      container.onpointermove = move;
      container.onpointerleave = () => {
        tooltip.hidden = true;
      };
    }
  }

  function niceCeil(value) {
    if (value <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const norm = value / pow;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * pow;
  }

  // ------------------------------------------------------------------ lists

  function renderBars(container, rows, valueFn, fillClass) {
    container.replaceChildren();
    if (!rows || rows.length === 0) {
      container.append(el("p", "empty-state", "Nothing here yet."));
      return;
    }
    const max = Math.max(1, ...rows.map(valueFn));
    rows.forEach((row) => {
      const wrapper = el("div", "bar-row");
      const top = el("div", "bar-top");
      const name = el("span", null, row.label);
      name.title = row.key || row.label;
      const value = el("b", null, formatMetric(row.usage));
      top.append(name, value);

      const track = el("div", "bar-track");
      const fill = el("div", "bar-fill" + (fillClass ? " " + fillClass : ""));
      fill.style.width = Math.max(1.5, (valueFn(row) / max) * 100) + "%";
      track.append(fill);

      const sub = el(
        "div",
        "bar-sub",
        fmtTokens(row.usage.totalTokens) + " tokens · " + fmtCost(row.usage.cost.total) + " · " + fmtPct(row.share, 1),
      );
      wrapper.append(top, track, sub);
      container.append(wrapper);
    });
  }

  function renderKindList(byKind) {
    renderBars($("kindList"), byKind.slice(0, 8), (row) => metricValue(row.usage), "kind");
  }

  function renderProjectList(byProject) {
    renderBars($("projectList"), byProject.slice(0, 8).map((row) => ({ ...row, label: basename(row.project) })), (row) => metricValue(row.usage), null);
  }

  // ----------------------------------------------------------------- tables

  function tableHead(table, columns) {
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");
    thead.replaceChildren();
    const tr = el("tr");
    columns.forEach((col) => {
      const th = el("th", null, col);
      tr.append(th);
    });
    thead.append(tr);
    tbody.replaceChildren();
    return tbody;
  }

  function shareCell(share) {
    const wrap = el("span", "share");
    const track = el("span", "share-track");
    const fill = el("span", "share-fill");
    fill.style.width = Math.max(1, Math.min(100, share * 100)) + "%";
    track.append(fill);
    wrap.append(track, el("span", null, fmtPct(share)));
    return wrap;
  }

  function renderModelTable(data) {
    const rows = data.byModel.slice(0, 15);
    const tbody = tableHead($("modelTable"), ["Model", "Provider", "Requests", "Tokens", "Cost", "Share"]);
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "empty", "No model usage in this range.");
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
    }
    rows.forEach((row) => {
      const tr = el("tr", "clickable");
      tr.title = "Click to filter by " + row.key;

      const nameTd = el("td");
      const name = el("div", "name");
      name.append(el("b", null, row.model), el("small", null, row.provider + " · " + row.sessions + " sessions"));
      nameTd.append(name);

      const provider = el("td", null, row.provider);
      const requests = el("td", "num", fmtInt(row.requests));
      const tokens = el("td", "num tokens", fmtTokens(row.usage.totalTokens));
      const cost = el("td", "num cost", fmtCost(row.usage.cost.total));
      const share = el("td");
      share.append(shareCell(row.share));

      tr.append(nameTd, provider, requests, tokens, cost, share);
      tr.addEventListener("click", () => {
        if (state.models.has(row.key)) state.models.delete(row.key);
        else state.models.add(row.key);
        loadStats();
      });
      tbody.append(tr);
    });
    $("modelHint").textContent =
      data.byModel.length > rows.length ? "top " + rows.length + " of " + data.byModel.length : data.byModel.length + " models";
  }

  function renderSessionTable(data) {
    const tbody = tableHead($("sessionTable"), ["Session", "Project", "Last active", "Requests", "Tokens", "Cost", "Share"]);
    const query = state.search.trim().toLowerCase();
    let rows = data.bySession;
    if (query) {
      rows = rows.filter((row) => {
        return (
          row.sessionName.toLowerCase().includes(query) ||
          row.sessionId.toLowerCase().includes(query) ||
          row.project.toLowerCase().includes(query) ||
          row.models.some((model) => model.toLowerCase().includes(query))
        );
      });
    }
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "empty", query ? "No sessions match “" + state.search + "”." : "No sessions in this range.");
      td.colSpan = 7;
      tr.append(td);
      tbody.append(tr);
    }
    rows.slice(0, 60).forEach((row) => {
      const tr = el("tr", "clickable");
      tr.title = "Open session detail";

      const nameTd = el("td");
      const name = el("div", "name");
      const title = el("b", null, row.sessionName + (state.session === row.sessionId ? " •" : ""));
      name.append(title, el("small", null, shortId(row.sessionId) + " · " + row.models.length + " models"));
      nameTd.append(name);

      const project = el("td", null, basename(row.project));
      project.title = row.project;

      tr.append(
        nameTd,
        project,
        el("td", null, relTime(row.lastActivityAt)),
        el("td", "num", fmtInt(row.requests)),
        el("td", "num tokens", fmtTokens(row.usage.totalTokens)),
        el("td", "num cost", fmtCost(row.usage.cost.total)),
        el("td"),
      );
      tr.lastChild.append(shareCell(row.share));
      tr.addEventListener("click", () => openDrawer(row.sessionId));
      tbody.append(tr);
    });
    $("sessionHint").textContent = query
      ? rows.length + " match" + (rows.length === 1 ? "" : "es")
      : data.bySession.length + " sessions";
  }

  function renderMeta(data) {
    const meta = $("dataMeta");
    meta.replaceChildren();
    const add = (label, value, className) => {
      meta.append(el("dt", null, label));
      const dd = el("dd", className, value);
      meta.append(dd);
      return dd;
    };
    add("Session files", fmtInt(data.scannedFiles));
    add("Events", fmtInt(data.eventsIncluded) + (data.eventsIncluded !== data.unfiltered.events ? " / " + fmtInt(data.unfiltered.events) : ""));
    add("Tokens counted", fmtTokens(data.totals.totalTokens) + (data.totals.requests ? "" : ""));
    add("Generated", new Date(data.generatedAt).toLocaleTimeString());
    const issues = data.issues || [];
    if (issues.length) {
      const badge = el("span", "badge warn", issues.length + " parse warning" + (issues.length === 1 ? "" : "s"));
      badge.title = issues.map((issue) => basename(issue.file) + ": " + issue.message).join("\n");
      const dt = el("dt", null, "Health");
      const dd = el("dd");
      dd.append(badge);
      meta.append(dt, dd);
    } else {
      const badge = el("span", "badge", "all files parsed");
      const dt = el("dt", null, "Health");
      const dd = el("dd");
      dd.append(badge);
      meta.append(dt, dd);
    }
    add("Directory", DIRS || data.sessionsDir, "wrap");
  }

  // ------------------------------------------------------------------ drawer

  async function openDrawer(sessionId) {
    drawerSessionId = sessionId;
    const drawer = $("sessionDrawer");
    drawer.setAttribute("aria-hidden", "false");
    $("drawerTitle").textContent = "Loading…";
    $("drawerSub").textContent = shortId(sessionId);
    $("drawerBody").replaceChildren(el("p", "empty-state", "Loading session…"));
    try {
      const detail = await api("/api/session", new URLSearchParams({ id: sessionId }));
      renderDrawer(detail);
    } catch (error) {
      $("drawerBody").replaceChildren(el("p", "empty-state", "Could not load session: " + error.message));
    }
  }

  function closeDrawer() {
    drawerSessionId = null;
    $("sessionDrawer").setAttribute("aria-hidden", "true");
  }

  function renderDrawer(detail) {
    const session = detail.session;
    $("drawerTitle").textContent = session.name;
    $("drawerSub").textContent = shortId(session.id) + " · " + session.project + " · " + relTime(session.lastActivityAt);

    const body = $("drawerBody");
    body.replaceChildren();

    const kpis = el("div", "drawer-kpis");
    const cards = [
      ["Total tokens", fmtTokens(session.usage.totalTokens)],
      ["Cost", fmtCost(session.usage.cost.total)],
      ["Requests", fmtInt(session.usage.requests)],
      ["Messages", fmtInt(session.messageCount)],
    ];
    cards.forEach(([label, value]) => {
      const card = el("article", "kpi");
      card.append(el("span", "kpi-label", label), el("strong", null, value));
      kpis.append(card);
    });
    body.append(kpis);

    const breakdown = el("div");
    breakdown.append(el("h3", null, "Token mix"));
    const mix = el("div", "bar-track");
    mix.style.height = "10px";
    const total = session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite;
    [["input", "var(--accent)"], ["output", "var(--success)"], ["cache", "var(--cache)"]].forEach(([name, color], index) => {
      const value = index === 0 ? session.usage.input : index === 1 ? session.usage.output : session.usage.cacheRead + session.usage.cacheWrite;
      if (total <= 0) return;
      const part = el("div");
      part.style.cssText = "height:100%;float:left;background:" + color + ";width:" + (value / total) * 100 + "%";
      part.title = name + ": " + fmtTokens(value);
      mix.append(part);
    });
    breakdown.append(mix);
    body.append(breakdown);

    const chartSection = el("section");
    chartSection.append(el("h3", null, "Daily usage"));
    const chartBox = el("div", "chart");
    chartSection.append(chartBox);
    body.append(chartSection);

    const modelsSection = el("section");
    modelsSection.append(el("h3", null, "Models"));
    const modelTable = el("table", "data");
    modelTable.append(el("thead"), el("tbody"));
    modelsSection.append(modelTable);
    body.append(modelsSection);

    const kindsSection = el("section");
    kindsSection.append(el("h3", null, "By kind"));
    const kindBox = el("div", "bars");
    kindsSection.append(kindBox);
    body.append(kindsSection);

    const recentSection = el("section");
    recentSection.append(el("h3", null, "Recent requests"));
    const recentTable = el("table", "data");
    recentTable.append(el("thead"), el("tbody"));
    recentSection.append(recentTable);
    body.append(recentSection);

    body.append(el("h3", null, "Session file"));
    const fileLine = el("p", "hint", session.file);
    fileLine.style.wordBreak = "break-all";
    body.append(fileLine);

    // Populate after mounting so clientWidth is available.
    requestAnimationFrame(() => {
      renderChart(chartBox, detail.byDay, { height: 170 });
      const modelBody = tableHead(modelTable, ["Model", "Requests", "Tokens", "Cost"]);
      detail.byModel.forEach((row) => {
        const tr = el("tr");
        const td = el("td");
        const name = el("div", "name");
        name.append(el("b", null, row.model), el("small", null, row.provider));
        td.append(name);
        tr.append(
          td,
          el("td", "num", fmtInt(row.requests)),
          el("td", "num tokens", fmtTokens(row.usage.totalTokens)),
          el("td", "num cost", fmtCost(row.usage.cost.total)),
        );
        modelBody.append(tr);
      });
      renderBars(kindBox, detail.byKind, (row) => metricValue(row.usage), "kind");

      const recentBody = tableHead(recentTable, ["When", "Kind", "Model", "Tokens", "Cost"]);
      detail.events
        .slice(-25)
        .reverse()
        .forEach((event) => {
          const tr = el("tr");
          const kind = event.kind === "assistant" ? (event.toolName ? "tool: " + event.toolName : "assistant") : event.kind;
          const when = el("td", null, relTime(event.timestamp));
          when.title = new Date(event.timestamp).toLocaleString();
          tr.append(
            when,
            el("td", null, kind),
            el("td", "num", event.model),
            el("td", "num tokens", fmtTokens(event.usage.totalTokens)),
            el("td", "num cost", fmtCost(event.usage.cost.total)),
          );
          recentBody.append(tr);
        });
    });
  }

  // ------------------------------------------------------------------ events

  function bindUi() {
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
    });

    $("refreshBtn").addEventListener("click", () => loadStats({ force: true }));
    $("resetBtn").addEventListener("click", () => {
      state.range = "all";
      state.from = "";
      state.to = "";
      state.models.clear();
      state.project = "";
      state.session = "";
      state.search = "";
      $("sessionSearch").value = "";
      loadStats();
    });
    $("clearSession").addEventListener("click", () => {
      state.session = "";
      loadStats();
    });
    $("focusSession").addEventListener("click", () => {
      if (!drawerSessionId) return;
      const focused = drawerSessionId;
      state.session = focused;
      closeDrawer();
      loadStats();
      toast("Focused session " + shortId(focused));
    });

    document.querySelectorAll("#rangeGroup button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.range = btn.dataset.range;
        state.from = "";
        state.to = "";
        loadStats();
      });
    });
    document.querySelectorAll("#metricGroup button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.metric = btn.dataset.metric;
        renderAll(latest);
      });
    });
    $("fromInput").addEventListener("change", (event) => {
      state.from = event.target.value;
      if (state.from || state.to) state.range = "custom";
      else state.range = "all";
      loadStats();
    });
    $("toInput").addEventListener("change", (event) => {
      state.to = event.target.value;
      if (state.from || state.to) state.range = "custom";
      else state.range = "all";
      loadStats();
    });

    $("sessionSearch").addEventListener("input", (event) => {
      state.search = event.target.value;
      if (latest) renderSessionTable(latest);
    });

    $("exportMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-export]");
      if (!button) return;
      const params = filterParams();
      params.set("dataset", button.dataset.export);
      params.set("token", TOKEN);
      window.location.href = "/api/export?" + params.toString();
      $("exportMenu").open = false;
    });

    document.querySelectorAll("[data-close-drawer]").forEach((node) => node.addEventListener("click", closeDrawer));
    $("sessionDrawer").addEventListener("click", (event) => {
      if (event.target === $("sessionDrawer")) closeDrawer();
    });

    $("shortcuts").addEventListener("click", (event) => {
      if (event.target === $("shortcuts")) $("shortcuts").hidden = true;
    });

    window.addEventListener("resize", () => {
      if (latest) renderChart($("chart"), latest.byDay, { height: 250, tooltip: $("chartTooltip") });
    });

    document.addEventListener("keydown", (event) => {
      const tag = (event.target && event.target.tagName) || "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (event.key === "Escape") {
        if (!$("shortcuts").hidden) {
          $("shortcuts").hidden = true;
          return;
        }
        if ($("sessionDrawer").getAttribute("aria-hidden") === "false") {
          closeDrawer();
          return;
        }
        if (typing) event.target.blur();
        return;
      }
      if (typing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "?":
          $("shortcuts").hidden = !$("shortcuts").hidden;
          event.preventDefault();
          break;
        case "t":
          cycleTheme();
          break;
        case "r":
          loadStats({ force: true });
          break;
        case "m":
          state.metric = state.metric === "tokens" ? "cost" : "tokens";
          if (latest) renderAll(latest);
          break;
        case "e":
          {
            const params = filterParams();
            params.set("dataset", "events");
            params.set("token", TOKEN);
            window.location.href = "/api/export?" + params.toString();
          }
          break;
        case "/":
          event.preventDefault();
          $("sessionSearch").focus();
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          const map = { "1": "1", "2": "7", "3": "30", "4": "90", "5": "all" };
          state.range = map[event.key];
          state.from = "";
          state.to = "";
          loadStats();
          break;
        }
        default:
          break;
      }
    });
  }

  // --------------------------------------------------------------------- sse

  function connectEvents() {
    const live = $("live");
    const label = $("liveLabel");
    if (!window.EventSource) {
      live.classList.add("off");
      label.textContent = "polling";
      startPolling();
      return;
    }
    let source;
    try {
      source = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
    } catch (_) {
      startPolling();
      return;
    }
    source.addEventListener("ready", () => {
      live.classList.add("on");
      live.classList.remove("off");
      label.textContent = "live";
      stopPolling();
    });
    source.addEventListener("refresh", () => {
      if (Date.now() - lastFetchAt > 900) queueFetch(true);
    });
    source.onerror = () => {
      live.classList.remove("on");
      live.classList.add("off");
      label.textContent = "reconnecting";
      startPolling();
    };
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => queueFetch(true), 15000);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ------------------------------------------------------------------- boot

  applyTheme(currentTheme());
  bindUi();
  loadStats();
  connectEvents();
})();
