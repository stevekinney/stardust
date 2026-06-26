import type { SubagentWorkflowInput, SubagentWorkflowResult } from '@src/lib/types';
import { sleep } from '@temporalio/workflow';

export async function researchSubagentWorkflow(
	input: SubagentWorkflowInput
): Promise<SubagentWorkflowResult> {
	await sleep('1ms');
	return {
		parentRunId: input.parentRunId,
		subagentRunId: input.subagentRunId,
		kind: 'research',
		status: 'complete',
		finalAnswer: 'Research subagent stub complete.',
		budgetDebit: input.budgetDebit,
		timelineLane: {
			id: input.subagentRunId,
			label: 'Research',
			kind: 'subagent',
			status: 'complete',
			budget: input.budgetDebit.usage
		}
	};
}
