import type {
	AgentRunInput,
	SessionState,
	SubmitTurnInput,
	SubmitTurnResult
} from '@src/lib/types';
import { condition, executeChild, setHandler } from '@temporalio/workflow';
import { agentRunWorkflow } from './agent-run.workflow';
import { getSessionStateQuery, submitTurnUpdate } from './session-contracts';

type QueuedTurn = { runId: string; message: string };

const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function agentSessionWorkflow(input: { sessionKey: string }): Promise<void> {
	const { sessionKey } = input;
	const queue: QueuedTurn[] = [];
	let activeRunId: string | null = null;
	let completedRunCount = 0;
	let submittedTurnCount = 0;

	void setHandler(
		getSessionStateQuery,
		(): SessionState => ({
			sessionKey,
			status: 'active',
			activeRunId,
			queueDepth: queue.length,
			completedRunCount
		})
	);

	void setHandler(submitTurnUpdate, (turn: SubmitTurnInput): SubmitTurnResult => {
		submittedTurnCount++;
		const runId = `${sessionKey}-run-${submittedTurnCount}`;
		queue.push({ runId, message: turn.message });
		return { accepted: true, runId };
	});

	while (true) {
		const timedOut = !(await condition(() => queue.length > 0, SESSION_IDLE_TTL_MS));
		if (timedOut) break;

		while (queue.length > 0) {
			const turn = queue.shift()!;
			activeRunId = turn.runId;
			try {
				await executeChild(agentRunWorkflow, {
					workflowId: `agent-run:${turn.runId}`,
					args: [
						{
							sessionKey,
							runId: turn.runId,
							message: turn.message
						} satisfies AgentRunInput
					]
				});
				completedRunCount++;
			} finally {
				activeRunId = null;
			}
		}
	}
}
