import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput,
	BudgetLedgerEntry,
	BudgetLedgerSnapshot,
	CriticAnnotation,
	ModelUsage,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	RunTimelineLane,
	SubagentKind,
	ToolCallInput,
	ToolExecutionInput,
	ToolExecutionResult,
	ToolPolicyDecision
} from '@src/lib/types';
import {
	allHandlersFinished,
	condition,
	executeChild,
	proxyActivities,
	setHandler,
	sleep
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import { getAgentRunStateQuery, resolveApprovalUpdate } from './approval-contracts';
import { codeSubagentWorkflow } from './subagents/code-subagent.workflow';
import { criticSubagentWorkflow } from './subagents/critic-subagent.workflow';
import { researchSubagentWorkflow } from './subagents/research-subagent.workflow';

type PolicyActivities = {
	evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision>;
	recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState>;
	recordApprovalResolution(input: RecordApprovalResolutionInput): Promise<ApprovalResolution>;
};

type ToolActivities = {
	executeTool(input: ToolExecutionInput & { approved?: boolean }): Promise<ToolExecutionResult>;
};

const TASK_QUEUE_TOOLS = 'tools-general';
const TASK_QUEUE_SANDBOX = 'tools-sandbox';
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const HANDLER_FINISH_TIMEOUT_MS = 60_000;
const DEFAULT_BUDGET_LIMIT: ModelUsage = {
	inputTokens: 120,
	outputTokens: 50,
	estimatedCostUsd: 0.0012
};
const REQUESTED_SUBAGENT_USAGE: Record<SubagentKind, ModelUsage> = {
	research: {
		inputTokens: 70,
		outputTokens: 20,
		estimatedCostUsd: 0.0007
	},
	code: {
		inputTokens: 70,
		outputTokens: 20,
		estimatedCostUsd: 0.0007
	},
	critic: {
		inputTokens: 20,
		outputTokens: 10,
		estimatedCostUsd: 0.0002
	}
};

const policyActivities = proxyActivities<PolicyActivities>({
	taskQueue: TASK_QUEUE_TOOLS,
	startToCloseTimeout: '10 seconds',
	retry: { maximumAttempts: 3 }
});

const sandboxActivities = proxyActivities<ToolActivities>({
	taskQueue: TASK_QUEUE_SANDBOX,
	startToCloseTimeout: '35 seconds',
	retry: { maximumAttempts: 1 }
});

function createApprovalId(runId: string, toolCallId: string): string {
	return `${runId}:${toolCallId}:approval`;
}

function createEmptyUsage(): ModelUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		estimatedCostUsd: 0
	};
}

function roundCost(value: number): number {
	return Number(value.toFixed(8));
}

function createBudgetLedger(limit: ModelUsage): BudgetLedgerSnapshot {
	return {
		limit,
		used: createEmptyUsage(),
		remaining: { ...limit },
		entries: []
	};
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		estimatedCostUsd: roundCost(left.estimatedCostUsd + right.estimatedCostUsd)
	};
}

function subtractUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
	return {
		inputTokens: left.inputTokens - right.inputTokens,
		outputTokens: left.outputTokens - right.outputTokens,
		estimatedCostUsd: roundCost(left.estimatedCostUsd - right.estimatedCostUsd)
	};
}

function reserveBudgetEntry(input: {
	ledger: BudgetLedgerSnapshot;
	runId: string;
	kind: SubagentKind;
	label: string;
}): BudgetLedgerEntry {
	const requested = REQUESTED_SUBAGENT_USAGE[input.kind];
	const usage: ModelUsage = {
		inputTokens: Math.min(requested.inputTokens, input.ledger.remaining.inputTokens),
		outputTokens: Math.min(requested.outputTokens, input.ledger.remaining.outputTokens),
		estimatedCostUsd: Math.min(requested.estimatedCostUsd, input.ledger.remaining.estimatedCostUsd)
	};
	const entry: BudgetLedgerEntry = {
		workflowId: `agent-run:${input.runId}:${input.kind}`,
		laneId: `${input.runId}:${input.kind}`,
		label: input.label,
		usage
	};
	input.ledger.used = addUsage(input.ledger.used, usage);
	input.ledger.remaining = subtractUsage(input.ledger.remaining, usage);
	input.ledger.entries.push(entry);
	return entry;
}

async function runDelegatedSubagents(
	input: AgentRunInput,
	finalAnswer: string
): Promise<{
	budgetLedger: BudgetLedgerSnapshot;
	timelineLanes: RunTimelineLane[];
	criticAnnotations: CriticAnnotation[];
}> {
	const budgetLedger = createBudgetLedger(input.budget ?? DEFAULT_BUDGET_LIMIT);
	const parentLane: RunTimelineLane = {
		id: input.runId,
		label: 'Parent run',
		kind: 'parent',
		status: 'running',
		budget: createEmptyUsage(),
		children: []
	};
	const researchDebit = reserveBudgetEntry({
		ledger: budgetLedger,
		runId: input.runId,
		kind: 'research',
		label: 'Research'
	});
	const codeDebit = reserveBudgetEntry({
		ledger: budgetLedger,
		runId: input.runId,
		kind: 'code',
		label: 'Code'
	});
	const criticDebit = reserveBudgetEntry({
		ledger: budgetLedger,
		runId: input.runId,
		kind: 'critic',
		label: 'Critic'
	});

	const [research, code, critic] = await Promise.all([
		executeChild(researchSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:research`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:research`,
					kind: 'research',
					message: input.message,
					budgetDebit: researchDebit
				}
			]
		}),
		executeChild(codeSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:code`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:code`,
					kind: 'code',
					message: input.message,
					budgetDebit: codeDebit
				}
			]
		}),
		executeChild(criticSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:critic`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:critic`,
					kind: 'critic',
					message: input.message,
					finalAnswer,
					budgetDebit: criticDebit
				}
			]
		})
	]);

	parentLane.status = 'complete';
	parentLane.children = [research.timelineLane, code.timelineLane, critic.timelineLane];
	return {
		budgetLedger,
		timelineLanes: [parentLane],
		criticAnnotations: critic.annotations ?? []
	};
}

/** Stub: no-tool model path. Yields control briefly so the parent session can accept concurrent turns. */
export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	let status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed' = 'running';
	let pendingApproval: ApprovalCardState | null = null;
	let approvalResolution: ApprovalResolutionInput | null = null;
	let recordedApprovalResolution: ApprovalResolution | null = null;
	let delegationResult:
		| {
				budgetLedger: BudgetLedgerSnapshot;
				timelineLanes: RunTimelineLane[];
				criticAnnotations: CriticAnnotation[];
		  }
		| undefined;

	void setHandler(getAgentRunStateQuery, () => ({
		runId: input.runId,
		status,
		pendingApproval
	}));

	void setHandler(resolveApprovalUpdate, async (resolution: ApprovalResolutionInput) => {
		if (!pendingApproval) {
			throw ApplicationFailure.nonRetryable('No approval is currently pending');
		}
		if (resolution.approvalId !== pendingApproval.approvalId) {
			throw ApplicationFailure.nonRetryable(
				`Approval ${resolution.approvalId} is not pending on this run`
			);
		}
		approvalResolution = resolution;
		const recorded = await condition(
			() => recordedApprovalResolution?.approvalId === resolution.approvalId,
			APPROVAL_TTL_MS
		);
		if (!recorded) {
			throw ApplicationFailure.nonRetryable(`Approval ${resolution.approvalId} was not recorded`);
		}
		return recordedApprovalResolution!;
	});

	for (const toolCall of input.toolCalls ?? []) {
		const decision = await policyActivities.evaluateToolCallPolicy({ call: toolCall });
		if (decision.status === 'denied') {
			return {
				runId: input.runId,
				status: 'failed',
				finalAnswer: `Tool call denied by policy: ${decision.reason}`
			};
		}

		if (decision.status === 'allowed') {
			await sandboxActivities.executeTool({
				call: toolCall,
				workspacePath: input.workspacePath
			});
			continue;
		}

		const approvalTtlMs = input.approvalTtlMs ?? APPROVAL_TTL_MS;
		const approvalId = createApprovalId(input.runId, toolCall.id);
		const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
		approvalResolution = null;
		recordedApprovalResolution = null;
		status = 'waiting_approval';
		pendingApproval = await policyActivities.recordApprovalRequest({
			approvalId,
			sessionId: input.sessionKey,
			runId: input.runId,
			toolCall,
			tool: decision.tool,
			policyVersion: decision.policyVersion,
			proposedArguments: toolCall.arguments,
			expiresAt
		});

		const resolvedBeforeExpiry = await condition(() => approvalResolution !== null, approvalTtlMs);
		if (!resolvedBeforeExpiry) {
			const expired = await policyActivities.recordApprovalResolution({
				approvalId,
				action: 'expire',
				reason: 'Approval expired before the user resolved it.',
				remember: false,
				actor: 'system'
			});
			pendingApproval = { ...pendingApproval, status: 'expired', resolution: expired };
			status = 'complete';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'complete',
				finalAnswer: 'Tool call approval expired before execution.'
			};
		}

		const recordedResolution = await policyActivities.recordApprovalResolution({
			approvalId,
			action: approvalResolution!.action,
			editedArguments: approvalResolution!.editedArguments,
			reason: approvalResolution!.reason,
			remember: approvalResolution!.remember,
			actor: approvalResolution!.actor ?? 'user'
		});
		recordedApprovalResolution = recordedResolution;
		pendingApproval = {
			...pendingApproval,
			status: recordedResolution.terminalState,
			resolution: recordedResolution
		};

		if (recordedResolution.terminalState === 'cancelled') {
			status = 'cancelled';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'cancelled',
				finalAnswer: recordedResolution.reason ?? 'Run cancelled during approval.'
			};
		}

		if (recordedResolution.terminalState !== 'approved') {
			status = 'complete';
			await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
			return {
				runId: input.runId,
				status: 'complete',
				finalAnswer:
					recordedResolution.reason ??
					`Tool call ${recordedResolution.terminalState} before execution.`
			};
		}

		status = 'running';
		pendingApproval = null;
		await sandboxActivities.executeTool({
			call: {
				...toolCall,
				arguments: recordedResolution.canonicalArguments
			},
			workspacePath: input.workspacePath,
			approved: true
		});
	}

	await sleep('1ms');
	const finalAnswer = '(stub — no model in T2)';
	if (input.delegateSubagents === true) {
		delegationResult = await runDelegatedSubagents(input, finalAnswer);
	}
	status = 'complete';
	await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
	return {
		runId: input.runId,
		status: 'complete',
		finalAnswer,
		...delegationResult
	};
}
