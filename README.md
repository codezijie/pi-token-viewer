# pi-token-viewer

Token & cost analytics for [pi](https://pi.dev) sessions — an interactive **TUI dashboard** and a local **web dashboard** with day/night themes.

Reads pi's JSONL session files directly. No database, no telemetry, no network calls.

```
  Token Viewer                                               2 sessions · 6 requests
────────────────────────────────────────────────────────────────────────────────────

  Tokens 8.87k   Cost $0.85   Requests 6   Cached 56%   Avg/req 1.48k

  ████████████████████████  █ input 3.61k  █ output 655  █ cache 4.6k

  range All time · model all · project all · metric tokens
   1 Overview │ 2 Models │ 3 Sessions │ 4 Days

  Daily tokens ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁█
  Jan 1   ████████████████████████████  8.27k    $0.80
  Jan 4   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 7   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 10  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 13  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 16  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 19  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 22  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 25  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 28  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░      0    $0.00
  Jan 31  ██░░░░░░░░░░░░░░░░░░░░░░░░░░    600    $0.05

  Top models
  anthropic/claude-x             ████████████████████    6.4k    $0.59
  openai/gpt-y                   ████████░░░░░░░░░░░░   2.46k    $0.26

────────────────────────────────────────────────────────────────────────────────────
  tab views · d range · m model · c metric · w web · ? help · q quit
```

## Features

**TUI dashboard** (`/tokens`)

- Overview with totals, cost, cache efficiency, average request size, daily chart and top models
- Dedicated **Models**, **Sessions** and **Days** views
- Drill into any session: model mix, usage kinds, recent requests
- Filters by date range, model and project, applied instantly in memory
- Switch the bar metric between **tokens** and **cost**
- Export every usage event to CSV without leaving the terminal

**Web dashboard** (`/tokens web`)

- Same numbers, larger canvas: KPI cards, stacked daily chart with hover tooltips, model/session/project tables and a session drawer
- **Auto / Light / Dark** themes (persisted, follows the system by default)
- Filter by date range, custom dates, multiple models, project and free-text session search
- Focus a single session as a filter, or open its detail drawer
- CSV export for events, sessions or daily rollups
- Live updates via Server-Sent Events when session files change
- Keyboard shortcuts (`?` for the list, `t` theme, `r` refresh, `1`–`5` ranges, `m` metric, `/` search, `e` export)
- Binds to loopback only, requires a per-run token, and rejects non-loopback `Host` headers

**Agent tool**

- `token_usage` (codemode exposure) lets the agent query totals with the same filters and group by model, day, session, project or kind — useful for "what did today cost?" questions.

## Install

From a local checkout:

```bash
pi install /path/to/pi-token-viewer
```

Or load it for one invocation:

```bash
pi -e /path/to/pi-token-viewer/extensions/token-viewer/index.ts
```

Or copy/symlink `extensions/token-viewer` into `~/.pi/agent/extensions/`.

The package ships TypeScript; pi loads it with jiti, so there is no build step.

## Usage

```text
/tokens                                  interactive TUI dashboard
/tokens web [--port N] [--no-open]       start the web dashboard (opens a browser)
/tokens summary [--days N] [--model k] [--project p] [--session id]
/tokens export [events|sessions|daily]   write a CSV into the current directory
/tokens status                           data + server status
/tokens open                             reopen the running dashboard
/tokens stop                             stop the web server
```

Examples:

```text
/tokens summary --days 7
/tokens export sessions
/tokens web --port 0            # random free port
/tokens summary --model anthropic/claude-sonnet-4-5
```

### TUI keys

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous view |
| `1` `2` `3` `4` | Overview, Models, Sessions, Days |
| `↑` `↓` / `j` `k` | Move selection |
| `enter` | Open the selected session |
| `esc` / `q` | Go back, then close |
| `d` / `shift+d` | Next / previous date range |
| `m` | Cycle model filter |
| `p` | Cycle project filter |
| `c` | Toggle tokens / cost metric |
| `s` | Cycle session sort (tokens, cost, recent) |
| `r` | Rescan session files |
| `w` | Open the web dashboard |
| `e` | Export events CSV |
| `?` | Help |

### Web dashboard shortcuts

`?` shortcuts · `t` theme · `r` refresh · `1`–`5` date ranges · `m` metric · `/` session search · `e` export · `esc` close drawer

## What counts

- **Every event on every branch.** Abandoned branches still cost money, so this is a billing view rather than a "current context" view.
- **All usage records:** assistant turns, tool sub-calls that report usage, cache warming, compaction and branch-summary generation, plus generic `usage` entries written by extensions.
- **Model attribution:** entries that omit `provider`/`model` (for example compaction summaries) inherit the most recent model in the session.
- Tokens are split into input, output, cache read and cache write. Cost uses the prices pi recorded in the session (`usage.cost`), so changing provider pricing later does not rewrite history.
- Session, model and project names come from the session header, `session_info` entries and the session folder name.

Data lives in:

```text
$PI_CODING_AGENT_SESSION_DIR        (if set)
~/.pi/agent/sessions               (default)
```

Override per session with `/tokens web --dir /path/to/sessions` or the `PI_CODING_AGENT_DIR` environment variable.

## Web dashboard security

- Listens on `127.0.0.1` only.
- Every route requires the random token printed in the URL (`/?token=…`).
- Rejects requests whose `Host` header is not a loopback name (DNS-rebinding defense).
- Serves a fixed set of static assets with a restrictive Content-Security-Policy.
- Read-only: there is no endpoint that modifies session files.

## CSV exports

`events` has one row per billable usage record with session, project, provider, model, kind and the full token/cost breakdown. `sessions` is a per-session rollup. `daily` is a per-day rollup suitable for spreadsheets.

## Development

```bash
npm install
npm test            # 34 tests: scanner, aggregation, CSV, TUI rendering, HTTP API, jsdom UI
npm run typecheck
npm run preview -- --dir ~/.pi/agent/sessions --port 4789
```

Project layout:

```text
extensions/token-viewer/index.ts   pi commands, tool, server lifecycle
src/scanner.ts                     JSONL discovery, parsing, caching
src/aggregate.ts                   filters, buckets, facets
src/export.ts                      CSV writers
src/format.ts                      token/cost/bar/sparkline formatting
src/tui/dashboard.ts               interactive TUI component
src/web/server.ts                  loopback HTTP + SSE server
src/web/static/                    no-build browser UI (HTML/CSS/JS)
test/                              fixtures, unit, HTTP, TUI and jsdom tests
```

## License

MIT
