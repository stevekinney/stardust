## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, vitest, playwright, drizzle, mcp

---

## Design Spec

The current design handoff is `Stardust Console v2.dc.html` (1384 lines) — the top-nav "Console v2" IA the app now implements: `Sessions · Inbox · Schedules · Artifacts · Insights`, a ⌘K command palette, and a header health cluster. When implementing UI, read the relevant section from this file—don't improvise layouts or spacing. The earlier `Stardust Console - Redesign.dc.html` (1566 lines, sidebar-era) is kept for reference only; its section index follows.

**Design section index:**

| Section | Name                                                  | Lines (approx) |
| ------- | ----------------------------------------------------- | -------------- |
| 01a     | Sessions populated (cards + FacetedFilterBar)         | 70–200         |
| 01b     | Sessions empty (first-run task input)                 | 200–350        |
| 02      | Session workspace streaming (split surface)           | 350–400        |
| 03a     | Run inspector hero (budget bar, step detail)          | 400–520        |
| 03b     | Engineer lens (EventStreamViewer)                     | 520–615        |
| 04a/b   | Approvals (in-session + center, "Approve with edits") | 520–695        |
| 05      | Memory (three layers + candidate review)              | 697–782        |
| 06a/b   | Workspace + sandbox inspector                         | 784–910        |
| 07      | Crash recovery ("Prove it yourself")                  | 912–1005       |
| 08      | Schedules (standing tasks + produced runs)            | 1007–1092      |
| 09      | Settings (model, budgets, appearance, local data)     | 1094–1184      |
| 10      | Run states (nine-state vocabulary)                    | 1186–1205      |
| 11a/b   | Responsive (tablet toggle, phone monitor/approval)    | 1207–1299      |

## Cinder Design System

Uses the checked-in `@lostgradient/cinder@0.13.0` baseline declared in `package.json` and locked in `bun.lock`. Key components and their imports:

```ts
import Badge from '@lostgradient/cinder/badge';
import Button from '@lostgradient/cinder/button';
import Select from '@lostgradient/cinder/select';
import StatusDot from '@lostgradient/cinder/status-dot';
import Textarea from '@lostgradient/cinder/textarea';
import Chat from '@lostgradient/cinder/chat';
import RunStepTimeline from '@lostgradient/cinder/run-step-timeline';
import PayloadInspector from '@lostgradient/cinder/payload-inspector';
import EventStreamViewer from '@lostgradient/cinder/event-stream-viewer';
import ApprovalCard from '@lostgradient/cinder/approval-card';
import FacetedFilterBar from '@lostgradient/cinder/faceted-filter-bar';
```

`src/routes/+layout.svelte` imports `@lostgradient/cinder/styles` plus per-component style sidecars. Do not switch back to `@lostgradient/cinder/styles/all` for production paths.

**Upstream issues:** `@lostgradient/*` packages are ours (repo: `stevekinney/cinder`). If you hit a bug, missing export, or need a new feature in Cinder, file a ticket on that repo with `gh issue create --repo stevekinney/cinder` including a clear repro or spec. Do not work around it silently, vendor a fork, or patch locally.

**Icons:** The design uses `lucide-icon` elements. In Svelte, render these as inline `<svg>` elements (the codebase already does this everywhere—don't add a Lucide dependency).

## Architecture Patterns

**App shell** (`+layout.svelte`): Cinder `NavigationBar` top bar (`src/lib/components/top-nav.svelte`) with STARDUST brand, the five section tabs (Inbox shows a count badge from `src/lib/inbox.svelte.ts`), the ⌘K palette trigger, the health cluster popover (`health-popover.svelte`, fed by `GET /api/health`, polled every 30s), and the settings gear. There is no sidebar. The command palette host (`command-palette.svelte`) is mounted globally in the layout.

**Page layout pattern:** Every top-level page is one centered column at `max-width: var(--cinder-content-width)` (72rem). Intentional exceptions: the chat transcript's ~760px reading column and the first-run hero (880px).

**Shared stores** (runes classes in `.svelte.ts`): `sessionsStore` (`src/lib/sessions.svelte.ts`, session list shared by the sessions page and palette) and `inbox` (`src/lib/inbox.svelte.ts`, polls `/api/approvals` + `/api/memory` every 10s for the badge and the Inbox page).

**Session workspace** (`/sessions/[sessionKey]`): session strip (back, status, title, run/spend meta, Temporal Web link) over a split surface—left pane is Conversation (Chat component, approvals render inline as `ApprovalCard`), right pane is the 560px run pane (`run-pane.svelte`): "This turn" identity card, replay scrubber over the durable transcript (`replay-scrubber.svelte`, client-only replay driven by transcript sequences), and Timeline / Events / Workspace / Costs tabs. The split can be toggled on tablet via a Conversation/Run segmented control.

**Approvals:** the Inbox (`/inbox`) and the in-conversation card both resolve through `POST /api/approvals/[approvalId]/resolve`, which fires the same `resolveApproval` Temporal Update against `agent-session:{sessionKey}` — one durable signal path, two surfaces.

**Nine run states:** empty, loading, streaming, waiting_approval, disconnected, recovered, failed, cancelled, complete. Each maps to a dot color and has specific UI treatment (see design section 10).

**Tool modules:** New agent tools live as one module per domain under `src/lib/server/tools/` (e.g. `public-data.ts`, `scratch-db.ts`), each exporting zod input schemas, executor functions with injectable deps, and a `defineXxxTools(): RegisteredTool[]` built with `defineStardustTool` from `define-tool.ts`. Risk/approval/task-queue metadata lives in `src/lib/server/policy/risk.ts`. Registration happens in `tool-definitions.ts`; execution dispatch in `execute-new-tool-call.ts`; platform/env gating in `registry.ts`'s `isToolConfigured`. Tools must stay keyless — `ANTHROPIC_API_KEY` is the only required secret (optional keys like `CONTEXT7_API_KEY` may raise limits but must never gate a tool's presence). Tools returning third-party text join the fenced-untrusted set in `registry.ts`.

**Responsive breakpoints:**

- Desktop: top nav + side-by-side split
- Tablet (≤1024px): session split panes become a Conversation/Run toggle
- Phone (≤640px): session view becomes monitor-only (`session-phone-surfaces.svelte` — status + steps + "Open on desktop" nudge, or a full-screen approval surface)

**Demo data:** Where the backend doesn't supply real data, use realistic mock data that matches the design's examples (session names like "Refactor auth guards", IDs like `ses_7af3`, workflow IDs like `wf_7af3`). The crash recovery demo is the hero beat—`bun run chaos` is the demo script.

## Available Svelte MCP Tools

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Preview Browser Is a Single Shared Resource

The Claude Preview tool gives one session exactly one shared browser tab—every `preview_start` call returns a new `serverId`, but they all drive the same underlying tab. There is no way to get an independent tab per agent. Two agents (or the main thread plus a background agent) calling `preview_navigate` / `preview_eval` / `preview_screenshot` concurrently will yank the tab out from under each other, surfacing as `target closed while handling command` or `Server not found. No running servers for this workspace`—not a real outage, just contention.

- **Background agents doing parallel code edits do not touch `preview_*` tools.** Verify their work with `bun run typecheck`, `bun run lint`, and `bun run test:unit`—deterministic, no shared resource, safe under concurrency.
- **Live visual verification is single-owner.** Do it from the orchestrating thread in one consolidated pass after parallel edit-agents finish, not from N agents each independently poking the browser.
- If an agent genuinely needs live visual verification mid-flight (a UX-focused task where source-level review isn't enough), gate it behind an atomic lock rather than skipping coordination entirely:
  ```bash
  # acquire (mkdir is atomic on POSIX—unlike a file-existence check)
  mkdir /tmp/claude-preview-stardust.lock 2>/dev/null && echo acquired || echo busy
  # if busy and the lock is older than 10 minutes, treat it as orphaned from a crashed agent and clear it
  find /tmp/claude-preview-stardust.lock -maxdepth 0 -mmin +10 -exec rmdir {} \;
  # release when done
  rmdir /tmp/claude-preview-stardust.lock
  ```
  An agent that finds the lock held and not stale should skip browser verification, rely on typecheck/lint/test, and say so in its report rather than fighting for the tab.

Do not treat repeated preview-tool failures during concurrent work as a broken dev server—check for other agents in flight before restarting or killing anything.
