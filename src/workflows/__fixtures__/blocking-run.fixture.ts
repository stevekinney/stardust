// Test fixture — exports the real session workflow with a blocking agentRunWorkflow stub.
// The blocking stub waits for a signal rather than a timer, so time-skipping tests
// can observe mid-flight session state before releasing the run.
export { agentSessionWorkflow } from '../agent-session.workflow';

import type { AgentRunInput, AgentRunResult } from '@src/lib/types';
import { condition, defineSignal, setHandler } from '@temporalio/workflow';

/** Send this signal (with the target runId) to the agentRunWorkflow child to unblock it. */
export const releaseRunSignal = defineSignal<[string]>('releaseRun');

export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	let released = false;
	void setHandler(releaseRunSignal, (targetRunId: string) => {
		if (targetRunId === input.runId) released = true;
	});
	await condition(() => released, 24 * 60 * 60 * 1000);
	return { runId: input.runId, status: 'complete', finalAnswer: '(blocking test stub)' };
}
