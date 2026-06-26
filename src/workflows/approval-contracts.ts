import type {
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput
} from '@src/lib/types';
import { defineQuery, defineUpdate } from '@temporalio/workflow';

export type AgentRunState = {
	runId: string;
	status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed';
	pendingApproval: ApprovalCardState | null;
};

export const resolveApprovalUpdate = defineUpdate<ApprovalResolution, [ApprovalResolutionInput]>(
	'resolveApproval'
);

export const getAgentRunStateQuery = defineQuery<AgentRunState, []>('getAgentRunState');
