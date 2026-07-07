# UX Audit — Stardust

Live walkthrough performed against a real running stack (SvelteKit web + Temporal worker + local Temporal dev server on `localhost:7234`/UI `8234`) via the `mcp__Claude_Preview__*` tools. Full stack was reachable and exercised end-to-end — this was **not** a static-only audit.

## Setup

- Started via `mcp__Claude_Preview__preview_start` with the `web` launch config (`bun run dev`, port 7777).
- `scripts/dev.ts` detected the configured `TEMPORAL_ADDRESS` pointed at a Temporal Cloud namespace unreachable from this environment, correctly discarded the leaked cloud credential, and started/reused a local Temporal dev server instead (auto-selected port 7234/8234 since 7233/8233 were occupied by an unrelated process already running on this machine).
- All five expected task-queue workers registered and reached `RUNNING`: `agent-orchestrator`, `model-calls`, `tools-general`, `tools-sandbox`, `memory`.

## Walkthrough 1 — Sessions list (populated state)

- `preview_snapshot` on `/` showed a proper accessibility tree: `navigation "Primary"` with five top-level links (Sessions/Inbox/Schedules/Artifacts/Insights), a `search "Filter sessions"` landmark containing a `searchbox` and a `combobox "Status"`, and a session list rendered as buttons with embedded "Open in Temporal Web" links.
- Inbox badge correctly reflected a live count ("Inbox 2" → later "Inbox 4" → "Inbox 3" as approvals were created/resolved during the walkthrough), confirming `src/lib/inbox.svelte.ts`'s poll loop is live and accurate.
- No console errors or warnings during initial load (checked via `preview_console_logs`, level `all`) beyond expected Vite HMR `[vite] connecting…/connected.` noise.

## Walkthrough 2 — First-run chat turn, streaming, tool call, approval, completion

Full sequence, from a freshly created session:

1. Clicked "New session" → `POST /api/sessions` → `201 Created` → navigated to `/sessions/[sessionKey]`.
2. Session page loaded with `role=log "Messages"` and `role=form "Chat message composer"` — correct ARIA structure for a chat surface.
3. Filled the composer (`.chat-input-editor`, a `<textarea>` with `aria-label="Message"` and `aria-describedby` pointing at a shortcut-hint description) with: "List the files in the current directory using the shell tool."
4. Clicked the send button (`.chat-input-send`, `aria-label="Send message"`).
5. Within ~2s: session header status flipped `idle` → `running`; a `role=status "Streaming"` badge and a `role=status "Streaming — anything you type steers the run"` banner appeared; assistant text streamed in ("I'll list the files in the current directory for you.").
6. A `shell.exec` tool-call card rendered in `Pending` state, immediately followed by an inline `ApprovalCard` (Cinder component) showing: risk badge "High risk," expiry countdown "Expires in 23h 59m," policy version `policy-2026-06`, a full idempotency key, the exact shell command (`ls -la`) in a labeled "SHELL" block, an "Arguments Preview" panel with Summary/Tree/Raw tabs, and Approve / Approve with edits / Deny / Remember / Cancel actions.
7. Approved via the "Approve" button (verified by exact button-text match, since Playwright's `:has-text()` pseudo-selector isn't available in this environment's `preview_click`).
8. The approval resolved (`POST /api/approvals/{id}/resolve` → `200 OK`), the tool card transitioned to a green "Complete" state, and a settled banner appeared: "Approved — the signal woke the workflow and shell.exec ran."
9. The agent then tried a second approach (`pwd`) after the first apparently didn't return the expected output cross-platform — this triggered a **second** `shell.exec` approval card with a fresh idempotency key. Approved the same way.
10. After the second approval, the run continued into a `workspace.searchFiles` tool call (auto-approved, no gate) and produced a final assistant answer describing the (empty, freshly `git init`'d) session workspace directory.
11. Run pane header updated to `complete`, `run 1`, `$0.10 spent`, and a "Temporal Web" deep link appeared. The right-hand stat tiles ("stream reconnects," "auto-retry," "heartbeat commands," "last durable event") went from all `—` to `0 / 0 / 3 / 14` — real telemetry, not placeholder text.
12. A terminal lifecycle marker rendered: green dot + "Run Complete."

This is a complete, verified pending → running → success tool-call visualization cycle, plus a real approval-gated durable-signal round trip, exactly matching the design spec's nine-state run vocabulary (section 10) and the approval architecture described in the project's own `CLAUDE.md`.

## Walkthrough 3 — Command palette keyboard interaction

- Dispatched a synthetic `Cmd+K` `KeyboardEvent` on `document` → palette opened as `role=dialog "Command palette"` containing a `role=combobox "Command palette"` and a `role=listbox` of `role=option` items (New session, Review pending approvals with a live "N waiting" description, Trigger schedule: morning-digest, several "Open session {name}" entries, Open Temporal Web, Open task queue agent-orchestrator). This is the correct ARIA combobox pattern (`combobox` + `listbox`/`option`, not a bare `menu`).
- Dispatched a synthetic `Escape` `KeyboardEvent` → palette closed (`role=dialog` no longer present in the DOM). Confirms the documented `esc close` footer hint is accurate.
- Footer hints (`↑↓ navigate`, `⏎ run`, `esc close`) are rendered as static text, not just implied — good for discoverability, though they are not themselves interactive/focusable, so a screen-reader user tabbing through only encounters them if they read the dialog's full content.

## Accessibility findings

- **Message list**: Cinder's `Chat` renders the transcript as `role="log"` with `aria-live="polite"` (turned `off` when virtualized), which is correct region semantics for a chat log — confirmed in Cinder's source (`chat.svelte:1607-1610`) and corroborated live by the `role=log "Messages"` node in the snapshot.
- **Streaming announcements**: A dedicated status announcer (`chat-status-announcer.svelte`) uses separate `polite`/`assertive` `aria-live` regions kept _outside_ the log to avoid double-announcing streamed tokens — this is a materially more careful pattern than the naive "put `aria-live=polite` directly on the growing text node" approach that causes over-announcement bugs (the exact class of bug OpenClaw has open as a live issue, see `state/OPENCLAW-GAPS.md`).
- **Composer**: `aria-label="Message"` on the textarea, `aria-label="Send message"` on the submit button, both wired to a shared `aria-describedby` shortcut-hint description ("Enter to send, Shift+Enter for newline," visible in the live screenshot) — good baseline labeling.
- **Command palette**: correct `dialog` → `combobox` + `listbox`/`option` structure, not a generic unlabeled popup.
- **Lifecycle/approval markers**: Stardust's own `stardustRow` snippet in `conversation-view.svelte` adds `role="status" aria-label="Run {status}"` on lifecycle markers and `role="alert" aria-label="Approval required: {toolName}"` on the pending-approval notice (the non-interactive fallback state, before the full `ApprovalCard` renders) — appropriately urgent semantics for an action-required state.
- **Gap**: the inline `ApprovalCard` itself (once rendered) is not wrapped in its own `aria-live` region distinct from the surrounding message log — a screen-reader user only learns "approval needed" via the log's own `polite` announcement of new content, not a distinct interrupt-level cue. Not a regression from OpenClaw (which has the opposite problem — over-announcing), but worth a `polite`-level dedicated announcement when a new approval becomes pending, independent of general log growth.
- **No skip-link or landmark heading level audit performed** — out of scope for this pass; flagged as a possible Phase 1+ accessibility-track item, not filed as a bug since no concrete violation was observed.

## Console / network findings

- No JavaScript console errors or warnings during the entire walkthrough (checked repeatedly via `preview_console_logs`).
- Four transient `404 Not Found` responses immediately after creating a new session, all of which self-resolved on the next poll — logged as `BUG-001` in `state/BUGS.md`.
- No unsanitized `{@html}` usage found anywhere in `src/` (`grep -rn "{@html" src` returned zero matches) — tool output and transcript content render through Cinder's `Chat` message model, not raw HTML injection. This is a meaningful security-posture positive, not a gap.
- No secrets, tokens, or API keys observed in `localStorage`/DOM during the walkthrough; the only `localStorage` usage found in `src/` is UI view-mode preference persistence (`src/lib/view-mode.svelte.ts`) and settings page state (`src/routes/settings/+page.svelte`) — neither touches credentials.
