import type {
	CriticAnnotation,
	SubagentWorkflowInput,
	SubagentWorkflowResult
} from '@src/lib/types';
import { sleep } from '@temporalio/workflow';

function includesAny(value: string, needles: string[]): boolean {
	return needles.some((needle) => value.includes(needle));
}

function createAdvisoryMessage(input: SubagentWorkflowInput): string {
	const finalAnswer = input.finalAnswer?.trim() ?? '';
	const normalizedAnswer = finalAnswer.toLowerCase();
	const reviewNotes: string[] = [];

	if (finalAnswer.length === 0) {
		reviewNotes.push('missing final answer content');
	}

	if (includesAny(normalizedAnswer, ['guarantee', 'guaranteed', 'always', 'never'])) {
		reviewNotes.push('absolute claim needs qualification');
	}

	if (!includesAny(normalizedAnswer, ['because', 'source', 'evidence', 'verified', 'test'])) {
		reviewNotes.push('evidence basis is not stated');
	}

	if (includesAny(normalizedAnswer, ['secret', 'token', 'password', 'api key'])) {
		reviewNotes.push('sensitive-data language needs review');
	}

	if (reviewNotes.length === 0) {
		reviewNotes.push('no blocking policy, evidence, or safety concern detected');
	}

	return `Advisory critic reviewed the final answer for policy adherence, missing evidence, and unsafe claims: ${reviewNotes.join('; ')}.`;
}

export async function criticSubagentWorkflow(
	input: SubagentWorkflowInput
): Promise<SubagentWorkflowResult> {
	await sleep('1ms');
	const annotation: CriticAnnotation = {
		id: `${input.subagentRunId}:annotation`,
		laneId: input.subagentRunId,
		message: createAdvisoryMessage(input),
		blocking: false
	};
	return {
		parentRunId: input.parentRunId,
		subagentRunId: input.subagentRunId,
		kind: 'critic',
		status: 'complete',
		finalAnswer: annotation.message,
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
