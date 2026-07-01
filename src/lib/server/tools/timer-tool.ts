import { z } from 'zod';
import type { RegisteredTool } from '../policy/policy-engine';
import { SESSION_MESSAGE_TOOL, TIMER_TOOL } from '../policy/risk';
import { defineStardustTool } from './define-tool';

/** Longest duration `timer.wait` accepts: 30 days, in milliseconds. */
const TIMER_WAIT_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Input schema for `timer.wait`. `durationMs` is bounded to 30 days — Temporal
 * durable timers can run far longer, but Stardust caps the tool to keep
 * "check back later" waits within a reviewable window.
 */
export const timerWaitInput = z.object({
	durationMs: z.number().int().positive().max(TIMER_WAIT_MAX_DURATION_MS),
	reason: z.string().min(1).optional()
});

export type TimerWaitInput = z.infer<typeof timerWaitInput>;

/**
 * Registers `timer.wait`.
 *
 * `timer.wait` is a durable wait executed by the orchestrator workflow itself
 * — the same way `delegate.parallel` is intercepted before it would ever reach
 * a tool activity. Because the wait is backed by Temporal's durable timer
 * (`condition(predicate, durationMs)`), it survives worker restarts and
 * crashes: on replay the workflow simply resumes waiting for whatever time is
 * left. Use it for "check back in N minutes/hours/days" patterns, anywhere
 * from a minute to 30 days. Cancelling the run interrupts the wait early.
 */
export function defineTimerTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'timer.wait',
			description:
				'Durably wait for a duration (minutes to 30 days) before continuing. Survives worker restarts and crashes — the wait is backed by a Temporal durable timer and is executed by the orchestrator workflow itself, not inside a tool activity. Use for "check back later" patterns.',
			schema: timerWaitInput,
			metadata: TIMER_TOOL
		})
	];
}

/**
 * Stub content a tool-activity registry should return for `timer.wait` if a
 * call ever reaches it. In practice this never happens: the orchestrator
 * workflow intercepts `timer.wait` before dispatching to a tool activity
 * (mirroring `delegate.parallel` in `registry.ts`). Exported so the registry
 * wiring pass can reuse this message instead of duplicating it.
 */
export function timerWaitStubContent(args: TimerWaitInput): {
	durationMs: number;
	reason?: string;
	message: string;
} {
	return {
		durationMs: args.durationMs,
		...(args.reason !== undefined ? { reason: args.reason } : {}),
		message: 'timer.wait is executed by the orchestrator workflow, not inside a tool activity.'
	};
}

// ── session.sendMessage ─────────────────────────────────────────────────────────
//
// The tool *definition* lives here — rather than in
// `../temporal/session-messaging.ts` — so that building the tool manifest
// never pulls in `@temporalio/client`. The manifest is also assembled on the
// web server, which describes available tools without needing a live
// Temporal connection. The executor (`sendSessionMessage`) lives in
// `../temporal/session-messaging` and is wired in by the tool-activity
// registry as an injected dependency.

/** Input schema for `session.sendMessage`. */
export const sessionSendMessageInput = z.object({
	sessionKey: z.string().min(1),
	message: z.string().min(1)
});

export type SessionSendMessageInput = z.infer<typeof sessionSendMessageInput>;

/**
 * Registers `session.sendMessage` — sends a message into another session,
 * enqueuing it as a new turn. Cross-session messaging can wake or feed a
 * dormant session, so it requires approval and a dedupe key (see
 * `SESSION_MESSAGE_TOOL` in `../policy/risk`).
 */
export function defineSessionMessagingTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'session.sendMessage',
			description:
				'Send a message into another session, enqueuing it as a new turn on that session. Requires approval.',
			schema: sessionSendMessageInput,
			metadata: SESSION_MESSAGE_TOOL
		})
	];
}
