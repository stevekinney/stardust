// Test fixture — exports the real session workflow with a blocking agentRunWorkflow stub.
// The blocking stub waits for a signal rather than a timer, so time-skipping tests
// can observe mid-flight session state before releasing the run.
export { agentSessionWorkflow } from '../agent-session.workflow';
// memoryCompactionWorkflow is included so the orchestrator worker bundle resolves
// the executeChild call added to the CAN path of agentSessionWorkflow.
export { memoryCompactionWorkflow } from '../memory-compaction.workflow';

import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalResolution,
	ApprovalResolutionInput,
	RunBudget
} from '@src/lib/types';
import {
	allHandlersFinished,
	condition,
	defineQuery,
	defineSignal,
	setHandler
} from '@temporalio/workflow';
import { steeringSignal } from '../approval-contracts';
import { resolveApprovalUpdate } from '../session-contracts';

/** Send this signal (with the target runId) to the agentRunWorkflow child to unblock it. */
export const releaseRunSignal = defineSignal<[string]>('releaseRun');

/**
 * Query: returns the steering messages received by this run so far.
 * Used in tests to assert that the session correctly forwarded steering.
 */
export const getSteeringBufferQuery = defineQuery<string[], []>('getSteeringBuffer');

/**
 * Query: returns the last ApprovalResolutionInput received via resolveApprovalUpdate, or null.
 * Used in tests to assert that the session correctly forwarded an approval resolution.
 */
export const receivedApprovalQuery = defineQuery<ApprovalResolutionInput | null, []>(
	'receivedApproval'
);

/**
 * Query: returns the `delegateSubagents` value from the AgentRunInput this stub received.
 * Used in tests to assert that the session correctly propagates the flag to child runs.
 */
export const getDelegateSubagentsQuery = defineQuery<boolean | undefined, []>(
	'getDelegateSubagents'
);

/**
 * Query: returns the `model` value from the AgentRunInput this stub received.
 * Used in tests to assert that the session correctly propagates model to child runs.
 */
export const getModelQuery = defineQuery<string | undefined, []>('getModel');

/**
 * Query: returns `budget.maxEstimatedCostUsd` from the AgentRunInput this stub received,
 * or undefined when no budget override was provided.
 * Used in tests to assert that maxBudgetUsd reaches the run as a budget override.
 */
export const getBudgetMaxCostQuery = defineQuery<number | undefined, []>('getBudgetMaxCost');

export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	let released = false;
	const steeringBuffer: string[] = [];
	let receivedApproval: ApprovalResolutionInput | null = null;

	void setHandler(releaseRunSignal, (targetRunId: string) => {
		if (targetRunId === input.runId) released = true;
	});

	void setHandler(steeringSignal, (message: string) => {
		steeringBuffer.push(message);
	});

	void setHandler(getSteeringBufferQuery, () => steeringBuffer);
	void setHandler(receivedApprovalQuery, () => receivedApproval);
	void setHandler(getDelegateSubagentsQuery, () => input.delegateSubagents);
	void setHandler(getModelQuery, () => input.model);
	void setHandler(
		getBudgetMaxCostQuery,
		() => (input.budget as RunBudget | undefined)?.maxEstimatedCostUsd
	);

	// Handle resolveApprovalUpdate so the approval-routing test can verify the
	// session forwards the resolution to the run. Returns a mock ApprovalResolution.
	void setHandler(
		resolveApprovalUpdate,
		async (resolution: ApprovalResolutionInput): Promise<ApprovalResolution> => {
			receivedApproval = resolution;
			const terminalState =
				resolution.action === 'approve' || resolution.action === 'approve_with_edits'
					? 'approved'
					: resolution.action === 'deny'
						? 'denied'
						: resolution.action === 'remember'
							? 'remembered'
							: 'cancelled';
			return {
				approvalId: resolution.approvalId,
				action: resolution.action,
				terminalState,
				canonicalArguments: resolution.editedArguments ?? {},
				proposedArguments: {},
				remember: resolution.remember ?? false,
				actor: resolution.actor ?? 'user',
				resolvedAt: new Date().toISOString()
			};
		}
	);

	await condition(() => released, 24 * 60 * 60 * 1000);
	// Drain any in-flight async update handlers (e.g. resolveApprovalUpdate) before
	// completing so a resolution in-flight at exit does not produce an
	// unfinished-handler warning.
	await condition(allHandlersFinished, '60 seconds');
	return {
		runId: input.runId,
		status: 'complete',
		finalAnswer: '(blocking test stub)',
		// Each stub run emits one memory ref so the session can accumulate them.
		memoryRefs: [`mem:${input.runId}`]
	};
}
