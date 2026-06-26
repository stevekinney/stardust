import type {
	CriticAnnotation,
	SubagentWorkflowInput,
	SubagentWorkflowResult
} from '@src/lib/types';
import { sleep } from '@temporalio/workflow';

export async function criticSubagentWorkflow(
	input: SubagentWorkflowInput
): Promise<SubagentWorkflowResult> {
	await sleep('1ms');
	const annotation: CriticAnnotation = {
		id: `${input.subagentRunId}:annotation`,
		laneId: input.subagentRunId,
		message: 'No-op critic stub: final answer left unchanged.',
		blocking: false
	};
	return {
		parentRunId: input.parentRunId,
		subagentRunId: input.subagentRunId,
		kind: 'critic',
		status: 'complete',
		finalAnswer: 'Critic subagent stub complete.',
		budgetDebit: input.budgetDebit,
		timelineLane: {
			id: input.subagentRunId,
			label: 'Critic',
			kind: 'subagent',
			status: 'complete',
			budget: input.budgetDebit.usage,
			annotations: [annotation]
		},
		annotations: [annotation]
	};
}
