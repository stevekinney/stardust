import type {
	ApprovalCardState,
	InterruptRunInput,
	InterruptRunResult,
	SessionMemorySnapshot,
	SessionSandboxSnapshot,
	SessionState,
	SubmitSteeringInput,
	SubmitSteeringResult,
	SubmitTurnInput,
	SubmitTurnResult
} from '@src/lib/types';
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';

// ── Updates ────────────────────────────────────────────────────────────────────

/** Update: submit a new user turn; returns accepted=true and a fresh runId. */
export const submitTurnUpdate = defineUpdate<SubmitTurnResult, [SubmitTurnInput]>('submitTurn');

/**
 * Update: inject a steering message into the currently active run.
 * Returns accepted=false (with a reason) when no run is active.
 * The message is forwarded to the run via steeringSignal and buffered
 * until the next model boundary.
 */
export const submitSteeringUpdate = defineUpdate<SubmitSteeringResult, [SubmitSteeringInput]>(
	'submitSteering'
);

/**
 * Update: interrupt the currently active run, optionally queuing a replacement
 * turn. The active run is cancelled via its CancellationScope; the session
 * returns to idle and picks up the next queued turn (or the replacement).
 */
export const interruptRunUpdate = defineUpdate<InterruptRunResult, [InterruptRunInput]>(
	'interruptRun'
);

// ── Signals ────────────────────────────────────────────────────────────────────

/**
 * Signal: cancel the entire session. Any active run is interrupted; the session
 * drains no further queue entries and exits to status='complete'.
 */
export const cancelRunSignal = defineSignal<[]>('cancelRun');

/**
 * Signal: a stream subscriber has disconnected. The workflow does not need to
 * react — streaming state is managed on the client side. This signal exists so
 * the gateway can notify the session without blocking on a result.
 */
export const streamDisconnectedSignal = defineSignal<[]>('streamDisconnected');

// ── Queries ────────────────────────────────────────────────────────────────────

/** Query: current session state snapshot (non-mutating). */
export const getSessionStateQuery = defineQuery<SessionState, []>('getSessionState');

/**
 * Query: basic info about the currently active run, or null when the session
 * is idle. Detailed run state (approvals, status) is available via the run
 * workflow's own getAgentRunState query.
 */
export const getActiveRunQuery = defineQuery<{ runId: string } | null, []>('getActiveRun');

/**
 * Query: pending approvals visible to the session. The session does not
 * directly observe the run's internal approval state, so this returns an
 * empty array. Callers that need real-time approval state should query
 * the active run workflow directly.
 */
export const getPendingApprovalsQuery = defineQuery<ApprovalCardState[], []>('getPendingApprovals');

/** Query: snapshot of memory candidate refs accumulated across all runs. */
export const getMemorySnapshotQuery = defineQuery<SessionMemorySnapshot, []>('getMemorySnapshot');

/**
 * Query: sandbox/workspace state tracked by the session. Returns workspacePath=null
 * until a sandbox activity provisions a workspace for this session.
 */
export const getSandboxSnapshotQuery = defineQuery<SessionSandboxSnapshot, []>(
	'getSandboxSnapshot'
);
