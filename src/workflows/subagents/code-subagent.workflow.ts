import type { SubagentWorkflowInput, SubagentWorkflowResult } from '@src/lib/types';
import { sleep } from '@temporalio/workflow';

export async function codeSubagentWorkflow(
	input: SubagentWorkflowInput
): Promise<SubagentWorkflowResult> {
	await sleep('1ms');
	return {
		parentRunId: input.parentRunId,
		subagentRunId: input.subagentRunId,
		kind: 'code',
		status: 'complete',
		finalAnswer: 'Code subagent stub complete.',
		budgetDebit: input.budgetDebit,
		timelineLane: {
			id: input.subagentRunId,
			label: 'Code',
			kind: 'subagent',
			status: 'complete',
			budget: input.budgetDebit.usage
		}
	};
}
