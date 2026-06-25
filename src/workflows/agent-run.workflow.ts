import type { AgentRunInput, AgentRunResult } from '@src/lib/types';
import { sleep } from '@temporalio/workflow';

/** Stub: no-tool model path. Yields control briefly so the parent session can accept concurrent turns. */
export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	await sleep('1ms');
	return {
		runId: input.runId,
		status: 'complete',
		finalAnswer: '(stub — no model in T2)'
	};
}
