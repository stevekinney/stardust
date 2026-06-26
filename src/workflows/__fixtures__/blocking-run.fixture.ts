// Test fixture — exports the real session workflow with a blocking agentRunWorkflow stub.
// The blocking stub waits for a signal rather than a timer, so time-skipping tests
// can observe mid-flight session state before releasing the run.
export { agentSessionWorkflow } from '../agent-session.workflow';

import type { AgentRunInput, AgentRunResult } from '@src/lib/types';
import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';
import { steeringSignal } from '../approval-contracts';

/** Send this signal (with the target runId) to the agentRunWorkflow child to unblock it. */
export const releaseRunSignal = defineSignal<[string]>('releaseRun');

/**
 * Query: returns the steering messages received by this run so far.
 * Used in tests to assert that the session correctly forwarded steering.
 */
export const getSteeringBufferQuery = defineQuery<string[], []>('getSteeringBuffer');

export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	let released = false;
	const steeringBuffer: string[] = [];

	void setHandler(releaseRunSignal, (targetRunId: string) => {
		if (targetRunId === input.runId) released = true;
	});

	void setHandler(steeringSignal, (message: string) => {
		steeringBuffer.push(message);
	});

	void setHandler(getSteeringBufferQuery, () => steeringBuffer);

	await condition(() => released, 24 * 60 * 60 * 1000);
	return {
		runId: input.runId,
		status: 'complete',
		finalAnswer: '(blocking test stub)',
		// Each stub run emits one memory ref so the session can accumulate them.
		memoryRefs: [`mem:${input.runId}`]
	};
}
