import type { RunInspectorProjection } from '$lib/server/observability/projection';

/**
 * Decides which detail fetches the session page is allowed to make on mount.
 *
 * Sessions are created lazily — the `sessions` DB row (and everything that
 * hangs off it: transcript events, runs, approvals) is only written once the
 * first `POST /turn` executes inside the Temporal workflow. A session page
 * can be reached in three distinct states:
 *
 * 1. **Fresh, with a first message** (`?start=...`, from the hero task
 *    input) — the page immediately submits that message as the first turn,
 *    which is what creates the session row. No detail fetch should race
 *    ahead of that.
 * 2. **Fresh, with no message yet** (`?fresh=1`, from "New session" — the
 *    hero button or the ⌘K palette) — there is nothing to fetch: no
 *    transcript, no runs, no approvals can exist yet, because the session
 *    row itself doesn't exist. Fetching anyway just produces a transient
 *    404 that resolves on the next poll (BUG-001). The right move is to do
 *    nothing until the user's first composer submit creates the session.
 * 3. **An existing session being revisited** (no `start`, no `fresh`) — the
 *    row is guaranteed to already exist, so it's safe to load the
 *    transcript, runs, and pending approvals immediately.
 *
 * `bootstrapSessionPage` is the single decision point for this, so the race
 * can't creep back in by a new caller firing a detail fetch unconditionally.
 */

export type SessionPageBootstrapDeps = {
	/** Set for a brand-new session navigated to without an initial message. */
	fresh: boolean;
	/** The initial message to submit, present for a brand-new session created with one. */
	startMessage: string | null;
	loadPendingApproval: () => Promise<void>;
	loadTranscript: () => Promise<void>;
	loadLatestRunInspector: () => Promise<RunInspectorProjection | null>;
	/** Submits the session's first turn — this is what creates the session row. */
	submitFirstTurn: (message: string) => Promise<void>;
};

export async function bootstrapSessionPage(deps: SessionPageBootstrapDeps): Promise<void> {
	if (deps.startMessage) {
		await deps.submitFirstTurn(deps.startMessage);
		return;
	}

	if (deps.fresh) {
		// Nothing exists server-side yet — wait for the first composer submit
		// instead of racing the workflow's session-creation write.
		return;
	}

	await Promise.all([
		deps.loadPendingApproval(),
		deps.loadTranscript().then(() => deps.loadLatestRunInspector())
	]);
}
