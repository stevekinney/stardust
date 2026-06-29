// Test fixture — exports the real session workflow with an agentRunWorkflow stub that
// throws a non-retryable ApplicationFailure. Used to test that the session handles
// run failures gracefully (stays alive and accepts subsequent turns).
export { agentSessionWorkflow } from '../agent-session.workflow';
// memoryCompactionWorkflow is included so the orchestrator worker bundle resolves
// the executeChild call added to the CAN path of agentSessionWorkflow.
export { memoryCompactionWorkflow } from '../memory-compaction.workflow';

import type { AgentRunResult } from '@src/lib/types';
import { ApplicationFailure } from '@temporalio/common';

/**
 * A stub agentRunWorkflow that immediately throws a non-retryable ApplicationFailure.
 * Used by session tests to verify that the session loop handles run failures without
 * bricking the session (the session must remain able to accept subsequent turns).
 */
export async function agentRunWorkflow(): Promise<AgentRunResult> {
	throw ApplicationFailure.nonRetryable('simulated run failure in fixture');
}
