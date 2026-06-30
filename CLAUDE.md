## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, vitest, playwright, drizzle, mcp

---

## Design Spec

The Claude Design handoff lives at `Stardust Console - Redesign.dc.html` (1566 lines). It contains 11 numbered sections (01–11), each with full HTML/CSS prototypes. When implementing UI, read the relevant section from this file—don't improvise layouts or spacing.

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

Uses `@lostgradient/cinder ^0.4.1`. Key components and their imports:

```ts
import Badge from '@lostgradient/cinder/badge';
import Button from '@lostgradient/cinder/button';
import Select from '@lostgradient/cinder/select';
import StatusDot from '@lostgradient/cinder/status-dot';
import Toggle from '@lostgradient/cinder/toggle';
import Textarea from '@lostgradient/cinder/textarea';
import Chat from '@lostgradient/cinder/chat';
import RunStepTimeline from '@lostgradient/cinder/run-step-timeline';
import PayloadInspector from '@lostgradient/cinder/payload-inspector';
import EventStreamViewer from '@lostgradient/cinder/event-stream-viewer';
import ApprovalCard from '@lostgradient/cinder/approval-card';
import FacetedFilterBar from '@lostgradient/cinder/faceted-filter-bar';
```

**SSR bug (Cinder issue #533):** Cinder can't SSR. `src/routes/+layout.ts` sets `export const ssr = false;`—don't change this.

**Upstream issues:** `@lostgradient/*` packages are ours (repo: `stevekinney/cinder`). If you hit a bug, missing export, or need a new feature in Cinder, file a ticket on that repo with `gh issue create --repo stevekinney/cinder` including a clear repro or spec. Do not work around it silently, vendor a fork, or patch locally. Source map warnings during tests are the known Cinder issue #562—don't file a duplicate.

**Icons:** The design uses `lucide-icon` elements. In Svelte, render these as inline `<svg>` elements (the codebase already does this everywhere—don't add a Lucide dependency).

## Architecture Patterns

**App shell** (`+layout.svelte`): 52px top bar + 236px left rail + main content. Top bar has STARDUST brand, session chip, worker StatusDot, UTH toggle, settings gear. Rail has session list + global nav (Approvals, Schedules, Memory, Settings) + Temporal footer.

**View mode** (`src/lib/view-mode.svelte.ts`): `'operator' | 'engineer'` toggle persisted to localStorage. Controls whether Temporal internals (EventStreamViewer, engineer lens chips) are visible.

**Page layout pattern:** Most pages use `PageHeader` component + either a centered column (settings) or a split view (sidebar + detail pane for approvals, schedules, memory).

**Split view pattern:**

- Sidebar width varies: 288px (approvals), 340px (schedules), 372px (memory review pane)
- Detail pane fills remaining space with `flex: 1; min-width: 0; overflow: auto`

**Session workspace** (`/sessions/[sessionKey]`): Split surface—left pane is Conversation (Chat component), right pane is Run inspector (durability ribbon + RunStepTimeline). The split can be toggled on tablet via a Conversation/Run segmented control.

**Nine run states:** empty, loading, streaming, waiting_approval, disconnected, recovered, failed, cancelled, complete. Each maps to a dot color and has specific UI treatment (see design section 10).

**Responsive breakpoints:**

- Desktop: full rail + side-by-side split
- Tablet (≤1024px): rail collapses to 56px icon-only; split panes become a Conversation/Run toggle
- Phone (≤640px): rail hidden behind overlay; session view becomes monitor-only (status + steps + "Open on desktop" nudge)

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
