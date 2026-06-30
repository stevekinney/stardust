import type {
	ModelCallInput,
	ModelCallResult,
	SubagentWorkflowInput,
	SubagentWorkflowResult
} from '@src/lib/types';
import { proxyActivities } from '@temporalio/workflow';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const TASK_QUEUE_MODEL = 'model-calls';

type ModelActivities = {
	callModel(input: ModelCallInput): Promise<ModelCallResult>;
};

const modelActivities = proxyActivities<ModelActivities>({
	taskQueue: TASK_QUEUE_MODEL,
	startToCloseTimeout: '120 seconds',
	retry: { maximumAttempts: 1 }
});

/**
 * Code subagent — calls the model with its slice of the shared budget and
 * returns the model's code-focused answer.
 */
export async function codeSubagentWorkflow(
	input: SubagentWorkflowInput
): Promise<SubagentWorkflowResult> {
	const modelResult = await modelActivities.callModel({
		sessionId: input.sessionKey,
		runId: input.subagentRunId,
		modelCallId: `${input.subagentRunId}:model-call-1`,
		model: input.model ?? DEFAULT_MODEL,
		systemPrompt: 'You are a code assistant. Write clean, concise code that solves the user task.',
		maxTokens: 1024
	});

	return {
		parentRunId: input.parentRunId,
		subagentRunId: input.subagentRunId,
		kind: 'code',
		status: 'complete',
		finalAnswer: modelResult.message.text,
		budgetDebit: {
			...input.budgetDebit,
			usage: modelResult.usage
		},
		timelineLane: {
			id: input.subagentRunId,
			label: 'Code',
			kind: 'subagent',
			status: 'complete',
			budget: modelResult.usage
		}
	};
}
