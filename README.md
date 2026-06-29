# Stardust

Stardust is a local, single-user proof of concept for a **Temporal-native durable agent harness**. It proves the agent loop is real — streaming, tool use, human approval, memory, subagents, schedules, and crash recovery — all running on one laptop with no cloud infrastructure beyond the model provider.

The whole system is five moving parts: one SvelteKit app (web UI + server routes + Temporal client), one Temporal Worker process (workflows + activities), one Temporal dev server, one SQLite file, and the Anthropic API. [`ARCHITECTURE.md`](./ARCHITECTURE.md) is the source of truth for how they fit together; this file is how you run it.

## Prerequisites

- **[Bun](https://bun.sh) 1.3+** — runtime, package manager, and test runner.
- **Node.js 20+** — the Temporal Worker runs under `tsx`, which executes on Node.
- **The [Temporal CLI](https://docs.temporal.io/cli)** — provides the local dev server and Temporal Web UI. On macOS: `brew install temporal`.
- **An Anthropic API key** — the one unavoidable external call. Everything else is local.

## Quick start

```sh
bun install
cp .env.example .env      # then open .env and set MODEL_API_KEY
bun run dev
```

`bun run dev` is a one-command orchestrator (`scripts/dev.ts`). It brings the stack up in dependency order so you don't have to juggle terminals:

- Reuses a Temporal dev server if one is already running, otherwise starts `temporal server start-dev` and waits until it is reachable.
- Applies database migrations.
- Starts the SvelteKit web process and the Temporal Worker process together, with prefixed `[web]` / `[worker]` logs.

When it is up you'll see:

- **App** — http://localhost:7777
- **Temporal Web** — http://localhost:7778

Those are the preferred ports (Temporal's frontend is 7776). If any is already taken, `bun run dev` automatically selects the next free port and prints the actual URLs in the startup banner — so a port collision never blocks startup.

Press `Ctrl-C` to stop everything. The orchestrator owns only what it started: if it launched the Temporal server it tears it down too, but a Temporal server you were already running is left untouched.

> [!NOTE]
> The app and run inspector start fine without `MODEL_API_KEY`, but any turn that calls the model will fail. The orchestrator prints a warning at startup if the key is missing.

## Configuration

Configuration is environment variables, read from `process.env`. Copy `.env.example` to `.env` and edit — both processes pick it up automatically (the web server through Vite/SvelteKit, the Temporal Worker through its own loader at startup), so there is no dotenv setup to wire up. **[`.env.example`](./.env.example) is the authoritative list**; the table below summarizes it.

| Variable                   | Default                        | Purpose                                                                           |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `MODEL_API_KEY`            | _(none — required)_            | Anthropic API key. Required for any turn that calls the model.                    |
| `TEMPORAL_ADDRESS`         | `localhost:7776`               | Temporal dev server frontend address.                                             |
| `TEMPORAL_NAMESPACE`       | `default`                      | Temporal namespace (see the note below).                                          |
| `TEMPORAL_WEB_PORT`        | `7778`                         | Port for the Temporal Web UI.                                                     |
| `DATABASE_URL`             | `file:~/.stardust/stardust.db` | SQLite database path. A leading `~` is expanded to your home directory.           |
| `ARTIFACT_DIR`             | `~/.stardust/artifacts`        | Root directory for spilled tool-output artifacts.                                 |
| `ARTIFACT_TOKEN_SECRET`    | `stardust-local-dev-secret`    | HMAC secret for local artifact download tokens. Override before exposing the app. |
| `TOOL_RESULT_INLINE_LIMIT` | `8000`                         | Byte threshold above which tool output is spilled to an artifact.                 |
| `SANDBOX_PROVIDER`         | `local-subprocess`             | Sandbox provider for tool execution. Only `local-subprocess` exists in the POC.   |

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
- Create and trigger a schedule.
- Open Temporal Web for any run straight from the inspector.

### Crash-recovery demo

The headline durability proof has its own script:

```sh
bun run chaos
```

It spins up a throwaway database and Temporal server, starts **two** Worker processes, drives a run to a tool-approval gate, kills one Worker mid-run, resolves the approval, and verifies the run completes on the surviving Worker. It prints `STARDUST_T11_CHAOS_OK <runId>` on success.

> [!WARNING]
> `bun run chaos` needs `MODEL_API_KEY` set — it depends on a real Anthropic `tool_use` response to reach the approval gate.

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
bun run test:unit      # unit only; add `-- --run` for a single pass
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

- **Model turns fail / "MODEL_API_KEY is required"** — set `MODEL_API_KEY` in `.env` (or export it in your shell) and restart so the Worker picks it up. `.env` is read from the directory you run from.
- **`temporal: command not found`** — install the Temporal CLI (`brew install temporal`).
- **Port already in use (7776 / 7777 / 7778)** — `bun run dev` handles this for you: it reuses a Temporal server already running on `TEMPORAL_ADDRESS`, and otherwise selects the next free port for Temporal, the UI, and the app, printing the actual URLs in its banner. To pin specific ports, set `TEMPORAL_ADDRESS` / `TEMPORAL_WEB_PORT` (and `APP_PORT` for the app). The standalone `bun run dev:web` falls back through Vite if 7777 is busy.
- **Reset all local state** — stop the app and delete `~/.stardust/` (database, artifacts, workspaces, model cache). The next run recreates it and re-applies migrations.
