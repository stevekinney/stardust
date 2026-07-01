import type {
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput
} from '@src/lib/types';
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';

export type AgentRunState = {
	runId: string;
	status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed';
	pendingApproval: ApprovalCardState | null;
};

export const resolveApprovalUpdate = defineUpdate<ApprovalResolution, [ApprovalResolutionInput]>(
	'resolveApproval'
);

export const getAgentRunStateQuery = defineQuery<AgentRunState, []>('getAgentRunState');

/**
 * Signal: inject a steering message into the active run's steering buffer.
 * The run drains this buffer at the next model boundary, including the message
 * as additional user-context before the model call.
 */
export const steeringSignal = defineSignal<[string]>('steeringMessage');

/**
 * Signal: request an in-band, graceful interruption of the active run.
 *
 * This is distinct from a hard Temporal cancellation of the run's workflow
 * execution (which the session still issues right after sending this signal,
 * as an unconditional safety net — see `agent-session.workflow.ts`). Hard
 * cancellation rejects any in-flight `condition()`/activity call immediately
 * with no chance to record a partial result. This signal instead flips an
 * in-band flag the run observes through an ordinary `condition()` predicate,
 * so an interruptible durable wait (currently `timer.wait`) can notice it,
 * finish computing and persisting a partial-result tool result through the
 * normal (non-cancelled) code path, and only then end the run with
 * status: 'cancelled' — all before the hard cancel arrives, best-effort.
 */
export const interruptRunSignal = defineSignal<[]>('interruptRun');
