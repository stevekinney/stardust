import type { ScheduledAgentInput, SubmitTurnResult } from '../lib/types';
import { proxyActivities } from '@temporalio/workflow';

type ScheduleActivities = {
	submitScheduledTurn(input: ScheduledAgentInput): Promise<SubmitTurnResult>;
};

const TASK_QUEUE_MEMORY = 'memory';

const { submitScheduledTurn } = proxyActivities<ScheduleActivities>({
	taskQueue: TASK_QUEUE_MEMORY,
	startToCloseTimeout: '30 seconds',
	retry: { maximumAttempts: 3 }
});

export async function scheduledAgentWorkflow(
	input: ScheduledAgentInput
): Promise<SubmitTurnResult> {
	return submitScheduledTurn(input);
}
