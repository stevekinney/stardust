import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput,
	BudgetLedgerEntry,
	BudgetLedgerSnapshot,
	CriticAnnotation,
	ModelCallInput,
	ModelCallResult,
	ModelUsage,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	RunBudget,
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
	setHandler
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import { getAgentRunStateQuery, resolveApprovalUpdate, steeringSignal } from './approval-contracts';
import { codeSubagentWorkflow } from './subagents/code-subagent.workflow';
import { criticSubagentWorkflow } from './subagents/critic-subagent.workflow';
import { researchSubagentWorkflow } from './subagents/research-subagent.workflow';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default model ID used when the run input does not specify one. */
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Default runtime budget applied when the run input omits `budget`. */
const DEFAULT_RUN_BUDGET: RunBudget = {
	maxModelCalls: 10,
	maxToolCalls: 20,
	maxChildWorkflows: 3,
	maxTokens: 100_000,
	maxActions: 30,
	maxActiveWallClockMs: 10 * 60 * 1000,
	maxEstimatedCostUsd: 1.0
};

const TASK_QUEUE_TOOLS = 'tools-general';
const TASK_QUEUE_SANDBOX = 'tools-sandbox';
const TASK_QUEUE_MODEL = 'model-calls';
const TASK_QUEUE_MEMORY = 'memory';
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const HANDLER_FINISH_TIMEOUT_MS = 60_000;
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

// ── Activity proxies ───────────────────────────────────────────────────────────

type PolicyActivities = {
	evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision>;
	recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState>;
	recordApprovalResolution(input: RecordApprovalResolutionInput): Promise<ApprovalResolution>;
};

type ToolActivities = {
	executeTool(input: ToolExecutionInput & { approved?: boolean }): Promise<ToolExecutionResult>;
};

type ObservabilityActivities = {
	recordRunStarted(input: { sessionId: string; runId: string; message: string }): Promise<void>;
	recordRunCompleted(input: {
		sessionId: string;
		runId: string;
		status: AgentRunResult['status'];
		finalAnswer: string;
	}): Promise<void>;
	recordSubagentStarted(input: {
		sessionId: string;
		runId: string;
		subagentRunId: string;
		kind: SubagentKind;
		label: string;
	}): Promise<void>;
	recordSubagentCompleted(input: {
		sessionId: string;
		runId: string;
		subagentRunId: string;
		kind: SubagentKind;
		label: string;
		status: 'complete' | 'failed' | 'cancelled';
		budget?: ModelUsage;
	}): Promise<void>;
	persistToolResult(input: {
		sessionId: string;
		runId: string;
		callId: string;
		content: unknown;
		isError?: boolean;
	}): Promise<void>;
};

type ModelActivities = {
	callModel(input: ModelCallInput): Promise<ModelCallResult>;
};

type MemoryActivities = {
	writeMemoryCandidate(input: {
		sessionId: string;
		runId: string;
		layer: 'session' | 'durable' | 'action_sensitive';
		content: string;
		tags?: string[];
		reason?: string | null;
	}): Promise<unknown>;
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

const observabilityActivities = proxyActivities<ObservabilityActivities>({
	taskQueue: TASK_QUEUE_TOOLS,
	startToCloseTimeout: '10 seconds',
	retry: { maximumAttempts: 3 }
});

const modelActivities = proxyActivities<ModelActivities>({
	taskQueue: TASK_QUEUE_MODEL,
	startToCloseTimeout: '120 seconds',
	retry: { maximumAttempts: 2 }
});

const memoryActivities = proxyActivities<MemoryActivities>({
	taskQueue: TASK_QUEUE_MEMORY,
	startToCloseTimeout: '10 seconds',
	retry: { maximumAttempts: 2 }
});

// ── Budget helpers ─────────────────────────────────────────────────────────────

function createApprovalId(runId: string, toolCallId: string): string {
	return `${runId}:${toolCallId}:approval`;
}

function createEmptyUsage(): ModelUsage {
	return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

function roundCost(value: number): number {
	return Number(value.toFixed(8));
}

function createBudgetLedger(budget: RunBudget): BudgetLedgerSnapshot {
	const limit: ModelUsage = {
		inputTokens: budget.maxTokens,
		outputTokens: Math.round(budget.maxTokens / 2),
		estimatedCostUsd: budget.maxEstimatedCostUsd
	};
	return { limit, used: createEmptyUsage(), remaining: { ...limit }, entries: [] };
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

/**
 * Reconciles a budget entry with the subagent's real model usage, returning
 * unused allocation to the shared ledger's remaining pool.
 */
function reconcileBudgetEntry(
	ledger: BudgetLedgerSnapshot,
	entry: BudgetLedgerEntry,
	realUsage: ModelUsage
): void {
	const diff = subtractUsage(entry.usage, realUsage);
	ledger.remaining = addUsage(ledger.remaining, diff);
	ledger.used = subtractUsage(ledger.used, diff);
	entry.usage = realUsage;
}

// ── Subagent delegation ────────────────────────────────────────────────────────

/**
 * Runs the research, code, and critic child workflows in parallel, then
 * reconciles real usage back into the shared budget ledger.
 *
 * `childWorkflowsAllowed` is the remaining child-workflow budget at the call
 * site (min of budget.maxChildWorkflows and remaining maxActions). If fewer
 * than three slots are available the delegation is skipped entirely
 * (all-or-nothing) to avoid a partial fanout without the safety critic.
 */
async function runDelegatedSubagents(
	input: AgentRunInput,
	finalAnswer: string,
	observability: Pick<ObservabilityActivities, 'recordSubagentStarted' | 'recordSubagentCompleted'>,
	childWorkflowsAllowed: number
): Promise<{
	budgetLedger: BudgetLedgerSnapshot;
	timelineLanes: RunTimelineLane[];
	criticAnnotations: CriticAnnotation[];
}> {
	const budget = input.budget ?? DEFAULT_RUN_BUDGET;
	const budgetLedger = createBudgetLedger(budget);
	const parentLane: RunTimelineLane = {
		id: input.runId,
		label: 'Parent run',
		kind: 'parent',
		status: 'running',
		budget: createEmptyUsage(),
		children: []
	};

	// Enforce maxChildWorkflows cap: all three subagents are spawned together as
	// a unit (research + code + critic). If the budget doesn't cover all three,
	// skip the delegation entirely rather than produce a partial fanout without
	// the safety critic.
	if (childWorkflowsAllowed < 3) {
		parentLane.status = 'complete';
		return { budgetLedger, timelineLanes: [parentLane], criticAnnotations: [] };
	}

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

	await Promise.all([
		observability.recordSubagentStarted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:research`,
			kind: 'research',
			label: 'Research'
		}),
		observability.recordSubagentStarted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:code`,
			kind: 'code',
			label: 'Code'
		}),
		observability.recordSubagentStarted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:critic`,
			kind: 'critic',
			label: 'Critic'
		})
	]);

	const [research, code, critic] = await Promise.all([
		executeChild(researchSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:research`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:research`,
					sessionKey: input.sessionKey,
					kind: 'research' as SubagentKind,
					message: input.message,
					budgetDebit: researchDebit,
					model: input.model
				}
			]
		}),
		executeChild(codeSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:code`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:code`,
					sessionKey: input.sessionKey,
					kind: 'code' as SubagentKind,
					message: input.message,
					budgetDebit: codeDebit,
					model: input.model
				}
			]
		}),
		executeChild(criticSubagentWorkflow, {
			workflowId: `agent-run:${input.runId}:critic`,
			args: [
				{
					parentRunId: input.runId,
					subagentRunId: `${input.runId}:critic`,
					sessionKey: input.sessionKey,
					kind: 'critic' as SubagentKind,
					message: input.message,
					finalAnswer,
					budgetDebit: criticDebit,
					model: input.model
				}
			]
		})
	]);

	// Reconcile real usage with reserved allocations.
	reconcileBudgetEntry(budgetLedger, researchDebit, research.budgetDebit.usage);
	reconcileBudgetEntry(budgetLedger, codeDebit, code.budgetDebit.usage);
	reconcileBudgetEntry(budgetLedger, criticDebit, critic.budgetDebit.usage);

	await Promise.all([
		observability.recordSubagentCompleted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:research`,
			kind: 'research',
			label: 'Research',
			status: research.status,
			budget: research.budgetDebit.usage
		}),
		observability.recordSubagentCompleted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:code`,
			kind: 'code',
			label: 'Code',
			status: code.status,
			budget: code.budgetDebit.usage
		}),
		observability.recordSubagentCompleted({
			sessionId: input.sessionKey,
			runId: input.runId,
			subagentRunId: `${input.runId}:critic`,
			kind: 'critic',
			label: 'Critic',
			status: critic.status,
			budget: critic.budgetDebit.usage
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

async function completeRun(input: AgentRunInput, result: AgentRunResult): Promise<AgentRunResult> {
	await observabilityActivities.recordRunCompleted({
		sessionId: input.sessionKey,
		runId: input.runId,
		status: result.status,
		finalAnswer: result.finalAnswer
	});
	return result;
}

// ── Approval handling ──────────────────────────────────────────────────────────

type MutableApprovalState = {
	status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed';
	pendingApproval: ApprovalCardState | null;
	approvalResolution: ApprovalResolutionInput | null;
	recordedApprovalResolution: ApprovalResolution | null;
};

/**
 * Runs policy evaluation → durable approval wait → tool execution for a single
 * tool call. Returns the `ToolExecutionResult` if executed, or a terminal
 * outcome if the call was denied, cancelled, or expired.
 */
async function handleToolCall(
	input: AgentRunInput,
	toolCall: ToolCallInput,
	state: MutableApprovalState
): Promise<
	| { kind: 'executed'; result: ToolExecutionResult }
	| { kind: 'terminal'; status: AgentRunResult['status']; finalAnswer: string }
> {
	const approvalTtlMs = input.approvalTtlMs ?? APPROVAL_TTL_MS;
	const decision = await policyActivities.evaluateToolCallPolicy({ call: toolCall });

	if (decision.status === 'denied') {
		return {
			kind: 'terminal',
			status: 'failed',
			finalAnswer: `Tool call denied by policy: ${decision.reason}`
		};
	}

	if (decision.status === 'allowed') {
		const result = await sandboxActivities.executeTool({
			call: toolCall,
			sessionId: input.sessionKey,
			sessionKey: input.sessionKey,
			runId: input.runId,
			workspacePath: input.workspacePath
		});
		return { kind: 'executed', result };
	}

	// Approval required — park in waiting_approval, wait for resolution update.
	const approvalId = createApprovalId(input.runId, toolCall.id);
	const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
	state.approvalResolution = null;
	state.recordedApprovalResolution = null;
	state.status = 'waiting_approval';
	state.pendingApproval = await policyActivities.recordApprovalRequest({
		approvalId,
		sessionId: input.sessionKey,
		runId: input.runId,
		toolCall,
		tool: decision.tool,
		policyVersion: decision.policyVersion,
		proposedArguments: toolCall.arguments,
		expiresAt
	});

	const resolvedBeforeExpiry = await condition(
		() => state.approvalResolution !== null,
		approvalTtlMs
	);
	if (!resolvedBeforeExpiry) {
		const expired = await policyActivities.recordApprovalResolution({
			approvalId,
			action: 'expire',
			reason: 'Approval expired before the user resolved it.',
			remember: false,
			actor: 'system'
		});
		state.pendingApproval = { ...state.pendingApproval!, status: 'expired', resolution: expired };
		state.status = 'complete';
		return {
			kind: 'terminal',
			status: 'complete',
			finalAnswer: 'Tool call approval expired before execution.'
		};
	}

	const recordedResolution = await policyActivities.recordApprovalResolution({
		approvalId,
		action: state.approvalResolution!.action,
		editedArguments: state.approvalResolution!.editedArguments,
		reason: state.approvalResolution!.reason,
		remember: state.approvalResolution!.remember,
		actor: state.approvalResolution!.actor ?? 'user'
	});
	state.recordedApprovalResolution = recordedResolution;
	state.pendingApproval = {
		...state.pendingApproval!,
		status: recordedResolution.terminalState,
		resolution: recordedResolution
	};

	if (recordedResolution.terminalState === 'cancelled') {
		state.status = 'cancelled';
		return {
			kind: 'terminal',
			status: 'cancelled',
			finalAnswer: recordedResolution.reason ?? 'Run cancelled during approval.'
		};
	}

	if (recordedResolution.terminalState !== 'approved') {
		state.status = 'complete';
		return {
			kind: 'terminal',
			status: 'complete',
			finalAnswer:
				recordedResolution.reason ??
				`Tool call ${recordedResolution.terminalState} before execution.`
		};
	}

	state.status = 'running';
	state.pendingApproval = null;
	const result = await sandboxActivities.executeTool({
		call: { ...toolCall, arguments: recordedResolution.canonicalArguments },
		sessionId: input.sessionKey,
		sessionKey: input.sessionKey,
		runId: input.runId,
		workspacePath: input.workspacePath,
		approved: true
	});
	return { kind: 'executed', result };
}

// ── Main workflow ──────────────────────────────────────────────────────────────

/**
 * AgentRunWorkflow — owns one prepared turn.
 *
 * Assembles context, calls the model, validates tool calls, enforces policy,
 * waits durably for approval, executes tools, publishes stream events, persists
 * canonical transcript events, and produces memory candidates.
 *
 * Streaming: the model-runner uses the Anthropic streaming API to publish token
 * deltas to stream_events while the provider stream is active, before the final
 * structured result is returned to the workflow.
 */
export async function agentRunWorkflow(input: AgentRunInput): Promise<AgentRunResult> {
	const budget = input.budget ?? DEFAULT_RUN_BUDGET;

	// Record wall-clock start time for maxActiveWallClockMs enforcement.
	// Date.now() is intercepted by Temporal's sandbox and returns deterministic
	// workflow time, making this replay-safe.
	const runStartMs = Date.now();

	let status: 'running' | 'waiting_approval' | 'complete' | 'cancelled' | 'failed' = 'running';
	let pendingApproval: ApprovalCardState | null = null;
	let approvalResolution: ApprovalResolutionInput | null = null;
	let recordedApprovalResolution: ApprovalResolution | null = null;

	const approvalState: MutableApprovalState = {
		get status() {
			return status;
		},
		set status(v) {
			status = v;
		},
		get pendingApproval() {
			return pendingApproval;
		},
		set pendingApproval(v) {
			pendingApproval = v;
		},
		get approvalResolution() {
			return approvalResolution;
		},
		set approvalResolution(v) {
			approvalResolution = v;
		},
		get recordedApprovalResolution() {
			return recordedApprovalResolution;
		},
		set recordedApprovalResolution(v) {
			recordedApprovalResolution = v;
		}
	};

	let delegationResult:
		| {
				budgetLedger: BudgetLedgerSnapshot;
				timelineLanes: RunTimelineLane[];
				criticAnnotations: CriticAnnotation[];
		  }
		| undefined;

	/**
	 * Steering messages queued by the session via steeringSignal.
	 * Drained at each model boundary and included in the model call context.
	 */
	const steeringBuffer: string[] = [];

	void setHandler(getAgentRunStateQuery, () => ({
		runId: input.runId,
		status,
		pendingApproval
	}));

	void setHandler(steeringSignal, (message: string) => {
		steeringBuffer.push(message);
	});

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

	await observabilityActivities.recordRunStarted({
		sessionId: input.sessionKey,
		runId: input.runId,
		message: input.message
	});

	// ── Model → tool loop ──────────────────────────────────────────────────────

	let modelCallCount = 0;
	let toolCallCount = 0;
	/** Unified counter: every tool-call execution and child-workflow launch increments this. */
	let actionsCount = 0;
	let totalUsage: ModelUsage = createEmptyUsage();
	// Definite-assignment assertion: every code path that reaches the code
	// below the loop assigns `finalAnswer` before breaking; the TypeScript
	// compiler cannot always infer this across labelled-loop boundaries.
	let finalAnswer!: string;

	outer: while (true) {
		if (modelCallCount >= budget.maxModelCalls) {
			finalAnswer = `Run stopped: model call budget exhausted (${budget.maxModelCalls} calls).`;
			break;
		}
		if (totalUsage.estimatedCostUsd >= budget.maxEstimatedCostUsd) {
			finalAnswer = `Run stopped: cost budget exhausted ($${totalUsage.estimatedCostUsd.toFixed(6)}).`;
			break;
		}
		if (totalUsage.inputTokens + totalUsage.outputTokens >= budget.maxTokens) {
			finalAnswer = `Run stopped: token budget exhausted (${totalUsage.inputTokens + totalUsage.outputTokens} tokens).`;
			break;
		}
		// Date.now() is intercepted by Temporal's sandbox and returns deterministic
		// workflow time, so this comparison is replay-safe.
		// eslint-disable-next-line temporal/workflow-no-nondeterministic-control-flow
		if (Date.now() - runStartMs >= budget.maxActiveWallClockMs) {
			finalAnswer = `Run stopped: wall-clock budget exhausted (${budget.maxActiveWallClockMs}ms).`;
			break;
		}

		// Drain any steering messages queued since the last model call.
		const pendingSteering = steeringBuffer.splice(0);
		const modelResult = await modelActivities.callModel({
			sessionId: input.sessionKey,
			runId: input.runId,
			model: input.model ?? DEFAULT_MODEL,
			tools: input.tools,
			systemPrompt: input.systemPrompt,
			maxTokens: 4096,
			...(pendingSteering.length > 0 ? { steeringMessages: pendingSteering } : {})
		});
		modelCallCount++;
		totalUsage = addUsage(totalUsage, modelResult.usage);

		if (modelResult.message.toolCalls.length === 0) {
			finalAnswer = modelResult.message.text;
			break;
		}

		for (const normalizedToolCall of modelResult.message.toolCalls) {
			// NormalizedToolCall uses `.input`; ToolCallInput uses `.arguments`.
			// Convert before passing into the policy/approval/execution path.
			const toolCall: ToolCallInput = {
				id: normalizedToolCall.id,
				name: normalizedToolCall.name,
				arguments: normalizedToolCall.input
			};

			if (toolCallCount >= budget.maxToolCalls) {
				finalAnswer = `Run stopped: tool call budget exhausted (${budget.maxToolCalls} calls).`;
				break outer;
			}
			if (actionsCount >= budget.maxActions) {
				finalAnswer = `Run stopped: action budget exhausted (${budget.maxActions} actions).`;
				break outer;
			}
			toolCallCount++;
			actionsCount++;

			const outcome = await handleToolCall(input, toolCall, approvalState);

			if (outcome.kind === 'terminal') {
				await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
				return completeRun(input, {
					runId: input.runId,
					status: outcome.status,
					finalAnswer: outcome.finalAnswer
				});
			}

			await observabilityActivities.persistToolResult({
				sessionId: input.sessionKey,
				runId: input.runId,
				callId: toolCall.id,
				content: outcome.result.content,
				isError: outcome.result.outcome === 'error'
			});
		}
	}

	// ── Subagent delegation (optional) ────────────────────────────────────────
	if (input.delegateSubagents === true) {
		// Enforce maxChildWorkflows and the remaining maxActions budget jointly.
		// Three child workflows are always spawned as a unit, so both caps must
		// allow at least three.
		const remainingActions = budget.maxActions - actionsCount;
		const childWorkflowsAllowed = Math.min(budget.maxChildWorkflows, remainingActions);
		delegationResult = await runDelegatedSubagents(
			input,
			finalAnswer,
			observabilityActivities,
			childWorkflowsAllowed
		);
	}

	// ── Session memory candidate ──────────────────────────────────────────────
	// Construct a deterministic ref for this run's memory candidate. The write is
	// non-fatal: if it fails the ref is still returned so the session can track it.
	const memoryRef = `${input.sessionKey}:run:${input.runId}`;
	await memoryActivities
		.writeMemoryCandidate({
			sessionId: input.sessionKey,
			runId: input.runId,
			layer: 'session',
			content: `Run ${input.runId}: ${finalAnswer.slice(0, 500)}`,
			tags: ['run-summary'],
			reason: 'Auto-generated run summary candidate'
		})
		.catch(() => undefined);

	status = 'complete';
	await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
	return completeRun(input, {
		runId: input.runId,
		status: 'complete',
		finalAnswer,
		memoryRefs: [memoryRef],
		...delegationResult
	});
}
