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
