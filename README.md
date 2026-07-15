# Stardust

Stardust is a personal AI agent built on **Temporal-native durable execution**—a local, single-user proof that durable workflows are the right substrate for agents. Streaming, tool use, human approval, memory, subagents, schedules, and crash recovery all run on one laptop, and the entire setup needs exactly one secret: an Anthropic API key.

That one-key rule is a design constraint, not an accident. Everything the agent can do out of the box—search the web, read feeds, drive a browser, check the weather, query library documentation, text your phone via iMessage, accumulate data in its own database—runs keylessly against public APIs, local machinery, or Anthropic's server-side tools billed to the key you already set. Clone it, paste one key, and you have a working agent with a thirty-seven-tool surface.

The durability is the point. Kill a worker mid-run and the run finishes on another one. Ask the agent to check back in three days and it sleeps _durably_—through restarts, redeploys, and your laptop lid closing—then picks up exactly where it left off. Approvals aren't modal state in a browser tab; they're workflow waits that survive anything short of deleting the database. `bun run chaos` proves it on demand.

The whole system is five moving parts: one SvelteKit app (web UI + server routes + Temporal client), one Temporal Worker process (workflows + activities), one Temporal dev server, one SQLite file, and the Anthropic API. [`ARCHITECTURE.md`](./ARCHITECTURE.md) is the source of truth for how they fit together; this file is how you run it.

## What the agent can do out of the box

Every tool below is live the moment `bun run dev` comes up—no OAuth dances, no second key, no config beyond `ANTHROPIC_API_KEY`.

**Web and knowledge**: web search and page fetching run as Anthropic's server-side `web_search`/`web_fetch` tools, so results (with citations) ride on the key you already set. Alongside them: `feed.read` for any RSS/Atom feed, `hackernews.read`, `weather.lookup` (Open-Meteo), `wikipedia.lookup`, and `docs.lookup` for up-to-date library documentation via Context7's anonymous tier.

**Hands**: the full sandboxed workspace—`workspace.*`, `shell.exec`, `process.*`, `verification.run`—with a git snapshot taken before every mutation so `sandbox.restore` can always walk it back. Two browser surfaces: the first-party `browser.inspect`/`browser.act` Playwright tools, and `browser.mcp.call`, which drives the bundled [Playwright MCP](https://github.com/microsoft/playwright-mcp) server through an allowlist (interaction and observation tools only—no `evaluate`, no filesystem, no storage access). Plus `db.query`: a private per-session SQLite scratchpad under `~/.stardust/agent-data/` that persists across runs, so the agent can accumulate data over days and query it later.

**Time—where Temporal shows off**:

- **`timer.wait`**: a durable sleep from minutes to thirty days. "Watch this and check back Friday" is a first-class, crash-proof operation, not a cron hack.
- **`schedule.create` / `schedule.list`**: the agent programs its own future by creating real Temporal Schedules—standing tasks that show up on the Schedules surface like any human-created one (creation is approval-gated).
- **`session.sendMessage`**: one session durably wakes and feeds another, so a scheduled morning-briefing run can hand its findings to your working session.

**Your machine (macOS)**: `notify.user` posts native desktop notifications, and `imessage.send` sends a real iMessage from your Messages account (approval-gated, of course). When any run parks in `waiting_approval`, Stardust buzzes your desktop unprompted—the agent asks permission the way a colleague would. Both tools hide themselves from the manifest on other platforms.

A good five-minute demo: ask for a morning briefing (Hacker News + your feeds + the weather), have it save what it learned to memory and `db.query`, tell it to schedule itself to do the same every weekday at 8am, then kill the worker mid-run and watch the run finish anyway.

## Prerequisites

- **[Bun](https://bun.sh) 1.3+** — runtime, package manager, and test runner.
- **Node.js 20+** — the Temporal Worker runs under `tsx`, which executes on Node.
- **The [Temporal CLI](https://docs.temporal.io/cli)** — provides the local dev server and Temporal Web UI. On macOS: `brew install temporal`.
- **An Anthropic API key** — the one unavoidable external call. Everything else is local.

## Quick start

```sh
bun install
cp .env.example .env      # then open .env and set ANTHROPIC_API_KEY
bun run dev
```

`bun run dev` is a one-command orchestrator (`scripts/dev.ts`). It brings the stack up in dependency order so you don't have to juggle terminals:

- Reuses a Temporal dev server if one is already running, otherwise starts `temporal server start-dev` and waits until it is reachable.
- Applies database migrations.
- Starts the SvelteKit web process and the Temporal Worker process together, with prefixed `[web]` / `[worker]` logs.

When it is up you'll see:

- **App** — http://localhost:7777
- **Temporal Web** — http://localhost:8233

Those are the preferred ports (Temporal's frontend is 7233 — Temporal's own defaults, so a Temporal dev server already running for another project is reused automatically). If a preferred port is taken by something other than Temporal, `bun run dev` selects the next free port and prints the actual URLs in the startup banner — so a port collision never blocks startup.

Press `Ctrl-C` to stop everything. The orchestrator owns only what it started: if it launched the Temporal server it tears it down too, but a Temporal server you were already running is left untouched.

> [!NOTE]
> The app and run inspector start fine without `ANTHROPIC_API_KEY`, but any turn that calls the model will fail. The orchestrator prints a warning at startup if the key is missing.

## Configuration

Configuration is environment variables, read from `process.env`. Copy `.env.example` to `.env` and edit — both processes pick it up automatically (the web server through Vite/SvelteKit, the Temporal Worker through its own loader at startup), so there is no dotenv setup to wire up. **[`.env.example`](./.env.example) is the authoritative list**; the table below summarizes it.

| Variable                   | Default                        | Purpose                                                                                                            |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`        | _(none — required)_            | Anthropic API key. Required for any turn that calls the model. Also powers the server-side web search/fetch tools. |
| `CONTEXT7_API_KEY`         | _(none — optional)_            | Optional Context7 key for `docs.lookup`. The anonymous tier works without it; a key raises rate limits.            |
| `TEMPORAL_ADDRESS`         | `localhost:7233`               | Temporal dev server frontend address.                                                                              |
| `TEMPORAL_NAMESPACE`       | `default`                      | Temporal namespace (see the note below).                                                                           |
| `TEMPORAL_WEB_PORT`        | `8233`                         | Port for the Temporal Web UI.                                                                                      |
| `DATABASE_URL`             | `file:~/.stardust/stardust.db` | SQLite database path. A leading `~` is expanded to your home directory.                                            |
| `ARTIFACT_DIR`             | `~/.stardust/artifacts`        | Root directory for spilled tool-output artifacts.                                                                  |
| `WORKSPACE_ROOT`           | `~/.stardust/workspaces`       | Root directory for local subprocess session workspaces.                                                            |
| `ARTIFACT_TOKEN_SECRET`    | `stardust-local-dev-secret`    | HMAC secret for local artifact download tokens. Override before exposing the app.                                  |
| `TOOL_RESULT_INLINE_LIMIT` | `8000`                         | Byte threshold above which tool output is spilled to an artifact.                                                  |
| `SANDBOX_PROVIDER`         | `local-subprocess`             | Sandbox provider for tool execution. Only `local-subprocess` exists in the POC.                                    |

> [!NOTE] Temporal namespace
> `temporal server start-dev` auto-creates the `default` namespace, so the common case needs no setup. If you set `TEMPORAL_NAMESPACE` to something else, you must also start the server with `--namespace <name>` — the dev server only auto-creates `default`.

Stardust keeps its local state under `~/.stardust/` (database, artifacts, per-session workspaces, and the embedding-model cache). Each of those directories is created on demand by the code that owns it — there is nothing to pre-create.

## Using the app

Open http://localhost:7777 and you can walk the full demo path:

- Create or resume a session — no sign-in.
- Submit a task and watch the output stream in.
- Inspect the run timeline (the hero surface): ordered steps, durations, attempts, budgets, and recovery markers.
- Approve a risky tool call from its durable approval card, and see the pre-mutation snapshot.
- Run a sandbox command in the session workspace.
- Refresh the page and watch canonical transcript state recover from SQLite.
- Review memory candidates.
- Create and trigger a schedule — or ask the agent to create one for itself with `schedule.create`.
- Ask for a briefing built from Hacker News, RSS feeds, weather, and Wikipedia — all keyless.
- Tell the agent to check back later with `timer.wait` and watch the run wait durably.
- On macOS, get a native desktop notification the moment a run needs your approval.
- Open Temporal Web for any run straight from the inspector.

### Crash-recovery demo

The headline durability proof has its own script:

```sh
bun run chaos
```

It spins up a throwaway database and Temporal server, starts **two** Worker processes, drives a run to a tool-approval gate, kills one Worker mid-run, resolves the approval, and verifies the run completes on the surviving Worker. It prints `STARDUST_T11_CHAOS_OK <runId>` on success.

> [!WARNING]
> `bun run chaos` needs `ANTHROPIC_API_KEY` set — it depends on a real Anthropic `tool_use` response to reach the approval gate.

## Commands

Day-to-day:

```sh
bun run dev            # one-command: Temporal + migrate + web + worker
bun run dev:app        # web + worker only (assumes Temporal is already running)
bun run dev:web        # just the SvelteKit web process
bun run dev:worker     # just the Temporal Worker process
bun run temporal:dev   # just the Temporal dev server + Web UI
```

Database (Drizzle):

```sh
bun run db:migrate     # apply migrations
bun run db:generate    # generate a migration from schema changes
bun run db:studio      # open Drizzle Studio
```

Verification gates:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test           # unit (Vitest) + end-to-end (Playwright)
bun run test:unit      # unit only; runs once by default
bun run build
```

## Project layout

```text
src/
  routes/        SvelteKit pages and API endpoints (the Temporal client lives here)
  lib/
    components/  Cinder-based UI components
    types/       Serializable contracts and schemas
    server/      Temporal client, Drizzle schema, stream bus, agent core, tools,
                 policy, sandbox, memory, artifacts
  workflows/     Deterministic Temporal workflow code
  activities/    Side-effecting activity implementations
  worker/        Temporal Worker bootstrap (hosts all task queues)
drizzle/         Generated migrations
scripts/         dev orchestrator, migration runner, chaos demo
```

The load-bearing rule is Temporal determinism: workflow code decides and waits but never performs side effects. SQLite, model calls, filesystem access, and subprocesses all live in activities. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full module-boundary map.

## Troubleshooting

- **Model turns fail / "ANTHROPIC_API_KEY is required"** — set `ANTHROPIC_API_KEY` in `.env` (or export it in your shell) and restart so the Worker picks it up. `.env` is read from the directory you run from.
- **`temporal: command not found`** — install the Temporal CLI (`brew install temporal`).
- **Port already in use (7233 / 7777 / 8233)** — `bun run dev` handles this for you: it reuses a Temporal server already running on `TEMPORAL_ADDRESS`, and otherwise selects the next free port for Temporal, the UI, and the app, printing the actual URLs in its banner. To pin specific ports, set `TEMPORAL_ADDRESS` / `TEMPORAL_WEB_PORT` (and `APP_PORT` for the app). The standalone `bun run dev:web` falls back through Vite if 7777 is busy.
- **No desktop notifications on macOS** — the first `notify.user` (or approval notification) triggers a one-time macOS permission prompt for `osascript`/Script Editor. If you dismissed it, re-enable under System Settings → Notifications.
- **`imessage.send` fails** — Messages.app must be signed in to iMessage, and macOS will ask once for automation permission the first time Stardust drives it.
- **Reset all local state** — stop the app and delete `~/.stardust/` (database, artifacts, workspaces, agent scratch databases, model cache). The next run recreates it and re-applies migrations.
