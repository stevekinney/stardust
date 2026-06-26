import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	ToolCallInput,
	ToolExecutionInput,
	ToolExecutionResult,
	ToolPolicyDecision
} from '@src/lib/types';
import {
	allHandlersFinished,
	condition,
	proxyActivities,
	setHandler,
	sleep
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import { getAgentRunStateQuery, resolveApprovalUpdate } from './approval-contracts';

type PolicyActivities = {
	evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision>;
	recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState>;
	recordApprovalResolution(input: RecordApprovalResolutionInput): Promise<ApprovalResolution>;
};

type ToolActivities = {
	executeTool(input: ToolExecutionInput & { approved?: boolean }): Promise<ToolExecutionResult>;
};

const TASK_QUEUE_TOOLS = 'tools-general';
const TASK_QUEUE_SANDBOX = 'tools-sandbox';
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const HANDLER_FINISH_TIMEOUT_MS = 60_000;

const policyActivities = proxyActivities<PolicyActivities>({
	taskQueue: TASK_QUEUE_TOOLS,
	startToCloseTimeout: '10 seconds',
	retry: { maximumAttempts: 3 }
});

const sandboxActivities = proxyActivities<ToolActivities>({
	taskQueue: TASK_QUEUE_SANDBOX,
	startToCloseTimeout: '35 seconds',
	retry: { maximumAttempts: 1 }
});

function createApprovalId(runId: string, toolCallId: string): string {
	return `${runId}:${toolCallId}:approval`;
}

/** Stub: no-tool model path. Yields control briefly so the parent session can accept concurrent turns. */
export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	let status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed' = 'running';
	let pendingApproval: ApprovalCardState | null = null;
	let approvalResolution: ApprovalResolutionInput | null = null;
	let recordedApprovalResolution: ApprovalResolution | null = null;

	void setHandler(getAgentRunStateQuery, () => ({
		runId: input.runId,
		status,
		pendingApproval
	}));

	void setHandler(resolveApprovalUpdate, async (resolution: ApprovalResolutionInput) => {
		if (!pendingApproval) {
			throw ApplicationFailure.nonRetryable('No approval is currently pending');
		}
		if (resolution.approvalId !== pendingApproval.approvalId) {
			throw ApplicationFailure.nonRetryable(
				`Approval ${resolution.approvalId} is not pending on this run`
			);
		}
		approvalResolution = resolution;
		const recorded = await condition(
			() => recordedApprovalResolution?.approvalId === resolution.approvalId,
			APPROVAL_TTL_MS
		);
		if (!recorded) {
			throw ApplicationFailure.nonRetryable(`Approval ${resolution.approvalId} was not recorded`);
		}
		return recordedApprovalResolution!;
	});

	for (const toolCall of input.toolCalls ?? []) {
		const decision = await policyActivities.evaluateToolCallPolicy({ call: toolCall });
		if (decision.status === 'denied') {
			return {
				runId: input.runId,
				status: 'failed',
				finalAnswer: `Tool call denied by policy: ${decision.reason}`
			};
		}

		if (decision.status === 'allowed') {
			await sandboxActivities.executeTool({
				call: toolCall,
				workspacePath: input.workspacePath
			});
			continue;
		}

		const approvalTtlMs = input.approvalTtlMs ?? APPROVAL_TTL_MS;
		const approvalId = createApprovalId(input.runId, toolCall.id);
		const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
		approvalResolution = null;
		recordedApprovalResolution = null;
		status = 'waiting_approval';
		pendingApproval = await policyActivities.recordApprovalRequest({
			approvalId,
			sessionId: input.sessionKey,
			runId: input.runId,
			toolCall,
			tool: decision.tool,
			policyVersion: decision.policyVersion,
			proposedArguments: toolCall.arguments,
			expiresAt
		});

		const resolvedBeforeExpiry = await condition(() => approvalResolution !== null, approvalTtlMs);
		if (!resolvedBeforeExpiry) {
			const expired = await policyActivities.recordApprovalResolution({
				approvalId,
				action: 'expire',
				reason: 'Approval expired before the user resolved it.',
				remember: false,
				actor: 'system'
			});
			pendingApproval = { ...pendingApproval, status: 'expired', resolution: expired };
			status = 'complete';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'complete',
				finalAnswer: 'Tool call approval expired before execution.'
			};
		}

		const recordedResolution = await policyActivities.recordApprovalResolution({
			approvalId,
			action: approvalResolution!.action,
			editedArguments: approvalResolution!.editedArguments,
			reason: approvalResolution!.reason,
			remember: approvalResolution!.remember,
			actor: approvalResolution!.actor ?? 'user'
		});
		recordedApprovalResolution = recordedResolution;
		pendingApproval = {
			...pendingApproval,
			status: recordedResolution.terminalState,
			resolution: recordedResolution
		};

		if (recordedResolution.terminalState === 'cancelled') {
			status = 'cancelled';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'cancelled',
				finalAnswer: recordedResolution.reason ?? 'Run cancelled during approval.'
			};
		}

		if (recordedResolution.terminalState !== 'approved') {
			status = 'complete';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'complete',
				finalAnswer:
					recordedResolution.reason ??
					`Tool call ${recordedResolution.terminalState} before execution.`
			};
		}

		status = 'running';
		pendingApproval = null;
		await sandboxActivities.executeTool({
			call: {
				...toolCall,
				arguments: recordedResolution.canonicalArguments
			},
			workspacePath: input.workspacePath,
			approved: true
		});
	}

	await sleep('1ms');
	status = 'complete';
	await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
	return {
		runId: input.runId,
		status: 'complete',
		finalAnswer: '(stub — no model in T2)'
	};
}
