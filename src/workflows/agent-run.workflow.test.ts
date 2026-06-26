import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
	AgentRunResult,
	ApprovalCardState,
	ApprovalResolution,
	ModelCallInput,
	ModelCallResult,
	ModelUsage,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	RunBudget,
	ToolCallInput,
	ToolExecutionInput,
	ToolExecutionResult,
	ToolManifestEntry,
	ToolPolicyDecision
} from '@src/lib/types';
import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_MODEL,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS
} from '@src/lib/types';
import { getAgentRunStateQuery, resolveApprovalUpdate } from './approval-contracts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const riskyTool: ToolManifestEntry = {
	name: 'workspace.writeFile',
	description: 'Write a file.',
	inputSchema: {},
	metadata: {
		risk: 'medium',
		requiresApproval: true,
		taskQueue: TASK_QUEUE_SANDBOX,
		timeoutMs: 15_000,
		retry: { maximumAttempts: 1 }
	}
};

const MOCK_MODEL_USAGE: ModelUsage = {
	inputTokens: 10,
	outputTokens: 5,
	estimatedCostUsd: 0.0001
};

function terminalStateForAction(
	action: RecordApprovalResolutionInput['action']
): ApprovalResolution['terminalState'] {
	if (action === 'approve' || action === 'approve_with_edits') return 'approved';
	if (action === 'deny') return 'denied';
	if (action === 'remember') return 'remembered';
	if (action === 'cancel') return 'cancelled';
	return 'expired';
}

// ── Approval suite ─────────────────────────────────────────────────────────────

/**
 * These tests exercise the durable approval mechanism: the model call returns a
 * tool_use block, the workflow parks in waiting_approval, and the test sends
 * a resolution via the resolveApprovalUpdate signal.
 */
describe('agentRunWorkflow approvals', () => {
	let env: TestWorkflowEnvironment;

	// Per-test state for mock activity capture.
	const activityState: {
		requests: RecordApprovalRequestInput[];
		resolutions: RecordApprovalResolutionInput[];
		executions: Array<ToolExecutionInput & { approved?: boolean }>;
		startedRuns: Array<{ sessionId: string; runId: string; message: string }>;
		completedRuns: Array<{
			sessionId: string;
			runId: string;
			status: 'complete' | 'failed' | 'cancelled';
			finalAnswer: string;
		}>;
	} = {
		requests: [],
		resolutions: [],
		executions: [],
		startedRuns: [],
		completedRuns: []
	};

	// Tracks how many times callModel has been invoked per runId so the mock
	// can return a tool_use on the first call and a final answer on the second.
	const modelCallCounts = new Map<string, number>();

	function resetState() {
		activityState.requests = [];
		activityState.resolutions = [];
		activityState.executions = [];
		activityState.startedRuns = [];
		activityState.completedRuns = [];
		modelCallCounts.clear();
	}

	// Build mock activities for the approval suite.
	// NOTE: callModel is the key mock — first call returns a tool_use for
	// workspace.writeFile (id: 'tool-call-001'), second call returns the final text.
	const testActivities = {
		async callModel(input: ModelCallInput): Promise<ModelCallResult> {
			const count = (modelCallCounts.get(input.runId) ?? 0) + 1;
			modelCallCounts.set(input.runId, count);

			const base = {
				runId: input.runId,
				model: input.model ?? 'claude-sonnet-4-5-20250929',
				usage: MOCK_MODEL_USAGE
			};

			if (count === 1) {
				// First call — return a workspace.writeFile tool_use to drive the
				// approval flow.
				return {
					...base,
					message: {
						text: '',
						toolCalls: [
							{
								id: 'tool-call-001',
								name: 'workspace.writeFile',
								input: { path: 'notes.txt', content: 'draft' }
							}
						]
					}
				};
			}

			// Subsequent calls — return the final text answer.
			return {
				...base,
				message: { text: 'Run complete.', toolCalls: [] }
			};
		},

		async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
			return {
				status: 'approval_required',
				tool: { ...riskyTool, name: input.call.name },
				policyVersion: '2026-06-26'
			};
		},

		async recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState> {
			activityState.requests.push(input);
			return {
				...input,
				argsHash: 'hash-001',
				createdAt: '2026-06-26T00:00:00.000Z',
				status: 'pending'
			};
		},

		async recordApprovalResolution(
			input: RecordApprovalResolutionInput
		): Promise<ApprovalResolution> {
			activityState.resolutions.push(input);
			const request = activityState.requests.find(
				(candidate) => candidate.approvalId === input.approvalId
			);
			if (!request) {
				throw ApplicationFailure.nonRetryable(`Missing request for ${input.approvalId}`);
			}
			const terminalState = terminalStateForAction(input.action);
			const editedArguments =
				input.action === 'approve_with_edits' ? input.editedArguments : undefined;
			const canonicalArguments =
				input.action === 'approve_with_edits' ? editedArguments : request.proposedArguments;
			return {
				approvalId: input.approvalId,
				action: input.action,
				terminalState,
				canonicalArguments,
				proposedArguments: request.proposedArguments,
				...(editedArguments === undefined ? {} : { editedArguments }),
				...(input.reason ? { reason: input.reason } : {}),
				remember: input.remember === true || input.action === 'remember',
				actor: input.actor,
				resolvedAt: input.resolvedAt ?? '2026-06-26T01:00:00.000Z'
			};
		},

		async executeTool(
			input: ToolExecutionInput & { approved?: boolean }
		): Promise<ToolExecutionResult> {
			activityState.executions.push(input);
			return {
				callId: input.call.id,
				toolName: input.call.name,
				outcome: 'success',
				content: { ok: true }
			};
		},

		async persistToolResult(): Promise<void> {
			// No-op: transcript persistence is tested in context-builder.test.ts
		},

		async recordRunStarted(input: { sessionId: string; runId: string; message: string }) {
			activityState.startedRuns.push(input);
		},

		async recordRunCompleted(input: {
			sessionId: string;
			runId: string;
			status: 'complete' | 'failed' | 'cancelled';
			finalAnswer: string;
		}) {
			activityState.completedRuns.push(input);
		},

		async recordSubagentStarted() {},
		async recordSubagentCompleted() {},
		async writeMemoryCandidate() {}
	};

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	beforeEach(() => {
		resetState();
	});

	async function runWithWorkers<T>(callback: () => Promise<T>): Promise<T> {
		const orchestrator = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		const tools = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_TOOLS,
			activities: testActivities
		});
		const sandbox = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_SANDBOX,
			activities: testActivities
		});
		const model = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MODEL,
			activities: testActivities
		});
		const memory = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities: testActivities
		});

		const task = orchestrator.runUntil(callback);
		const toolsTask = tools.runUntil(task.catch(() => undefined));
		const sandboxTask = sandbox.runUntil(task.catch(() => undefined));
		const modelTask = model.runUntil(task.catch(() => undefined));
		const memoryTask = memory.runUntil(task.catch(() => undefined));
		const [result] = await Promise.all([task, toolsTask, sandboxTask, modelTask, memoryTask]);
		return result;
	}

	it('parks a risky tool call in waiting_approval after the model requests it', async () => {
		await runWithWorkers(async () => {
			const runId = `approval-park-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'write the file',
						approvalTtlMs: 60_000
					}
				]
			});

			// Wait for the workflow to park in waiting_approval after the model
			// returns the tool_use block and policy evaluation triggers approval.
			let state = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 10 && state.status !== 'waiting_approval'; i++) {
				await env.sleep(100);
				state = await handle.query(getAgentRunStateQuery);
			}

			expect(state.status).toBe('waiting_approval');
			expect(state.pendingApproval?.approvalId).toBe(`${runId}:tool-call-001:approval`);
			expect(activityState.requests).toHaveLength(1);

			// Cancel to terminate the run.
			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId: `${runId}:tool-call-001:approval`, action: 'cancel', reason: 'stop' }]
			});
			await handle.result();
		});
	});

	it('executes edited arguments after approve-with-edits', async () => {
		await runWithWorkers(async () => {
			const runId = `approval-edits-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'write the file',
						approvalTtlMs: 60_000
					}
				]
			});

			const approvalId = `${runId}:tool-call-001:approval`;
			for (let i = 0; i < 10; i++) {
				const state = await handle.query(getAgentRunStateQuery);
				if (state.pendingApproval?.approvalId === approvalId) break;
				await env.sleep(100);
			}

			const editedArguments = { path: 'notes.txt', content: 'approved text' };
			const resolution = await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'approve_with_edits', editedArguments, remember: true }]
			});
			const result = await handle.result();

			expect(resolution.proposedArguments).toEqual({ path: 'notes.txt', content: 'draft' });
			expect(resolution.editedArguments).toEqual(editedArguments);
			expect(resolution.canonicalArguments).toEqual(editedArguments);
			expect(result.status).toBe('complete');
			expect(activityState.executions).toHaveLength(1);
			expect(activityState.executions[0].call.arguments).toEqual(editedArguments);
			expect(activityState.executions[0].approved).toBe(true);
		});
	});

	it('treats denial as a soft terminal decision without executing the tool', async () => {
		await runWithWorkers(async () => {
			const runId = `approval-deny-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'write the file',
						approvalTtlMs: 60_000
					}
				]
			});

			const approvalId = `${runId}:tool-call-001:approval`;
			for (let i = 0; i < 10; i++) {
				const state = await handle.query(getAgentRunStateQuery);
				if (state.pendingApproval?.approvalId === approvalId) break;
				await env.sleep(100);
			}

			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'deny', reason: 'Too risky.' }]
			});
			const result = await handle.result();

			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toBe('Too risky.');
			expect(activityState.executions).toHaveLength(0);
		});
	});

	it('expires approval as a soft deny and continues without executing the tool', async () => {
		await runWithWorkers(async () => {
			const runId = `approval-expire-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'write the file',
						approvalTtlMs: 1_000
					}
				]
			});

			const result = await handle.result();

			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toBe('Tool call approval expired before execution.');
			expect(activityState.resolutions).toEqual([
				expect.objectContaining({ action: 'expire', actor: 'system' })
			]);
			expect(activityState.executions).toHaveLength(0);
		});
	});
});

// ── Subagent delegation suite ──────────────────────────────────────────────────

/**
 * Tests the subagent delegation path: research, code, and critic child workflows
 * run in parallel, report real model usage back to the parent, and the budget
 * ledger is reconciled with actual usage.
 */
describe('agentRunWorkflow subagents', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('runs research, code, and critic subagents; reconciles real model usage in the budget ledger', async () => {
		// The subagent model mock always returns a text answer (no tool calls).
		// Research and code subagents each make one model call with MOCK_MODEL_USAGE.
		// The critic makes no model call and returns zero usage.
		const subagentTestActivities = {
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				return {
					runId: input.runId,
					model: input.model ?? 'claude-sonnet-4-5-20250929',
					message: { text: 'Mock model answer.', toolCalls: [] },
					usage: MOCK_MODEL_USAGE
				};
			},
			async evaluateToolCallPolicy(): Promise<ToolPolicyDecision> {
				return { status: 'denied', reason: 'Should not be called in subagents test' };
			},
			async recordApprovalRequest(): Promise<ApprovalCardState> {
				throw ApplicationFailure.nonRetryable('Should not be called in subagents test');
			},
			async recordApprovalResolution(): Promise<ApprovalResolution> {
				throw ApplicationFailure.nonRetryable('Should not be called in subagents test');
			},
			async executeTool(): Promise<ToolExecutionResult> {
				throw ApplicationFailure.nonRetryable('Should not be called in subagents test');
			},
			async persistToolResult(): Promise<void> {},
			async recordRunStarted() {},
			async recordRunCompleted() {},
			async recordSubagentStarted() {},
			async recordSubagentCompleted() {},
			async writeMemoryCandidate() {}
		};

		const orchestrator = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		const tools = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_TOOLS,
			activities: subagentTestActivities
		});
		const model = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MODEL,
			activities: subagentTestActivities
		});
		const memory = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities: subagentTestActivities
		});

		const task = orchestrator.runUntil(async () => {
			const runId = `subagents-${Date.now()}`;
			const result: AgentRunResult = await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'research the option, draft the change, and critique the answer',
						delegateSubagents: true,
						budget: {
							maxModelCalls: 10,
							maxToolCalls: 20,
							maxChildWorkflows: 3,
							maxTokens: 300,
							maxActions: 30,
							maxActiveWallClockMs: 5 * 60 * 1000,
							maxEstimatedCostUsd: 0.002
						} satisfies RunBudget
					}
				]
			});

			const criticLaneId = `${runId}:critic`;

			// Parent run calls the mock model once → returns text → finalAnswer is set.
			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toBe('Mock model answer.');

			// Research and code each used MOCK_MODEL_USAGE (10 in, 5 out, $0.0001).
			// Critic used zero (no model call).
			// Total reconciled: 10 + 10 + 0 = 20 input tokens.
			expect(result.budgetLedger?.used).toEqual({
				inputTokens: 20,
				outputTokens: 10,
				estimatedCostUsd: 0.0002
			});

			expect(result.budgetLedger?.entries.map((entry) => entry.laneId)).toEqual([
				`${runId}:research`,
				`${runId}:code`,
				criticLaneId
			]);

			// Critic entry has zero usage because the critic is heuristic-only.
			expect(result.budgetLedger?.entries.find((entry) => entry.laneId === criticLaneId)).toEqual(
				expect.objectContaining({
					usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
				})
			);

			// Sum of all entry usage equals total used.
			expect(
				result.budgetLedger?.entries.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)
			).toBe(20);

			// Timeline structure: one parent lane with three child subagent lanes.
			expect(result.timelineLanes).toEqual([
				expect.objectContaining({
					id: runId,
					children: [
						expect.objectContaining({ id: `${runId}:research`, kind: 'subagent' }),
						expect.objectContaining({ id: `${runId}:code`, kind: 'subagent' }),
						expect.objectContaining({
							id: criticLaneId,
							kind: 'subagent',
							// Critic reports zero model usage in its timeline lane.
							budget: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
							annotations: [
								expect.objectContaining({
									blocking: false,
									laneId: criticLaneId,
									message: expect.stringContaining('Advisory critic reviewed the final answer')
								})
							]
						})
					]
				})
			]);

			expect(result.criticAnnotations).toEqual([
				expect.objectContaining({
					blocking: false,
					laneId: criticLaneId,
					message: expect.stringContaining('Advisory critic reviewed the final answer')
				})
			]);
		});

		const toolsTask = tools.runUntil(task.catch(() => undefined));
		const modelTask = model.runUntil(task.catch(() => undefined));
		const memoryTask = memory.runUntil(task.catch(() => undefined));
		await Promise.all([task, toolsTask, modelTask, memoryTask]);
	});
});

// ── Budget caps suite ──────────────────────────────────────────────────────────

/**
 * These tests exercise the runtime enforcement of every RunBudget field that
 * wasn't covered by the approval or subagent suites.
 *
 * All tests use a policy that returns `allowed` so the tool-call execution path
 * is taken immediately, without approval flow interference. This isolates the
 * budget cap as the sole termination reason.
 */
describe('agentRunWorkflow budget caps', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	/** Allows all tool calls immediately (no approval dance). */
	const allowedTool: ToolManifestEntry = {
		name: 'test.noop',
		description: 'A no-op tool.',
		inputSchema: {},
		metadata: {
			risk: 'low',
			requiresApproval: false,
			taskQueue: TASK_QUEUE_SANDBOX,
			timeoutMs: 5_000,
			retry: { maximumAttempts: 1 }
		}
	};

	/**
	 * Builds a base activity set for budget-cap tests.
	 * `callModelFn` is injected so individual tests can control what the model
	 * returns without rebuilding the whole activity set.
	 */
	function buildCapActivities(callModelFn: (input: ModelCallInput) => Promise<ModelCallResult>): {
		callModel(input: ModelCallInput): Promise<ModelCallResult>;
		evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision>;
		recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState>;
		recordApprovalResolution(input: RecordApprovalResolutionInput): Promise<ApprovalResolution>;
		executeTool(input: ToolExecutionInput & { approved?: boolean }): Promise<ToolExecutionResult>;
		persistToolResult(): Promise<void>;
		recordRunStarted(): Promise<void>;
		recordRunCompleted(): Promise<void>;
		recordSubagentStarted(): Promise<void>;
		recordSubagentCompleted(): Promise<void>;
		writeMemoryCandidate(): Promise<void>;
	} {
		return {
			callModel: callModelFn,
			async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
				return { status: 'allowed', tool: { ...allowedTool, name: input.call.name } };
			},
			async recordApprovalRequest(): Promise<ApprovalCardState> {
				throw ApplicationFailure.nonRetryable('Should not be called in budget caps test');
			},
			async recordApprovalResolution(): Promise<ApprovalResolution> {
				throw ApplicationFailure.nonRetryable('Should not be called in budget caps test');
			},
			async executeTool(
				input: ToolExecutionInput & { approved?: boolean }
			): Promise<ToolExecutionResult> {
				return {
					callId: input.call.id,
					toolName: input.call.name,
					outcome: 'success',
					content: { ok: true }
				};
			},
			async persistToolResult(): Promise<void> {},
			async recordRunStarted(): Promise<void> {},
			async recordRunCompleted(): Promise<void> {},
			async recordSubagentStarted(): Promise<void> {},
			async recordSubagentCompleted(): Promise<void> {},
			async writeMemoryCandidate(): Promise<void> {}
		};
	}

	/** Spins up one orchestrator + all activity workers and runs `callback`. */
	async function runCapTest<T>(
		activities: ReturnType<typeof buildCapActivities>,
		callback: () => Promise<T>
	): Promise<T> {
		const orchestrator = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		const tools = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_TOOLS,
			activities
		});
		const sandbox = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_SANDBOX,
			activities
		});
		const model = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MODEL,
			activities
		});
		const memory = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities
		});

		const task = orchestrator.runUntil(callback);
		const [result] = await Promise.all([
			task,
			tools.runUntil(task.catch(() => undefined)),
			sandbox.runUntil(task.catch(() => undefined)),
			model.runUntil(task.catch(() => undefined)),
			memory.runUntil(task.catch(() => undefined))
		]);
		return result;
	}

	it('enforces maxModelCalls and returns the budget-exhausted message on the second turn', async () => {
		// The model always returns a tool call so the loop can never terminate via a
		// text answer — the only exit is the budget cap. With maxModelCalls:1 the
		// cap fires at the top of the second outer-loop iteration, after the first
		// model call and one tool execution have completed.
		const activities = buildCapActivities(async (input: ModelCallInput) => ({
			runId: input.runId,
			model: input.model,
			message: {
				text: '',
				toolCalls: [{ id: 'cap-tool-001', name: 'test.noop', input: {} }]
			},
			usage: MOCK_MODEL_USAGE
		}));

		await runCapTest(activities, async () => {
			const runId = `budget-model-calls-${Date.now()}`;
			const result: AgentRunResult = await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-cap',
						runId,
						message: 'do something',
						budget: {
							maxModelCalls: 1,
							maxToolCalls: 20,
							maxChildWorkflows: 3,
							maxTokens: 100_000,
							maxActions: 30,
							maxActiveWallClockMs: 5 * 60 * 1000,
							maxEstimatedCostUsd: 1.0
						} satisfies RunBudget
					}
				]
			});

			// First outer iteration: model called (modelCallCount → 1), returns
			// tool_use → tool executed → back to top of loop.
			// Second outer iteration: modelCallCount (1) >= maxModelCalls (1) → cap.
			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toContain('model call budget exhausted');
		});
	});

	it('enforces maxActions and returns the budget-exhausted message', async () => {
		// With maxActions:1 the first tool call sets actionsCount to 1. The model
		// is called again (maxModelCalls is high), returns another tool_use, and
		// the inner-loop actionsCount check fires before the second tool is run.
		const activities = buildCapActivities(async (input: ModelCallInput) => ({
			runId: input.runId,
			model: input.model,
			message: {
				text: '',
				toolCalls: [{ id: 'cap-tool-001', name: 'test.noop', input: {} }]
			},
			usage: MOCK_MODEL_USAGE
		}));

		await runCapTest(activities, async () => {
			const runId = `budget-actions-${Date.now()}`;
			const result: AgentRunResult = await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-cap',
						runId,
						message: 'do something',
						budget: {
							maxModelCalls: 10,
							maxToolCalls: 20,
							maxChildWorkflows: 3,
							maxTokens: 100_000,
							maxActions: 1,
							maxActiveWallClockMs: 5 * 60 * 1000,
							maxEstimatedCostUsd: 1.0
						} satisfies RunBudget
					}
				]
			});

			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toContain('action budget exhausted');
		});
	});

	it('enforces maxActiveWallClockMs:0 and exits before the first model call', async () => {
		// maxActiveWallClockMs:0 means Date.now() - runStartMs >= 0 is always true,
		// so the cap fires at the very top of the first outer-loop iteration before
		// any model call is attempted.
		let modelCallCount = 0;
		const activities = buildCapActivities(async (input: ModelCallInput) => {
			modelCallCount++;
			return {
				runId: input.runId,
				model: input.model,
				message: { text: 'Should never reach this.', toolCalls: [] },
				usage: MOCK_MODEL_USAGE
			};
		});

		await runCapTest(activities, async () => {
			const runId = `budget-wallclock-${Date.now()}`;
			const result: AgentRunResult = await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-cap',
						runId,
						message: 'do something',
						budget: {
							maxModelCalls: 10,
							maxToolCalls: 20,
							maxChildWorkflows: 3,
							maxTokens: 100_000,
							maxActions: 30,
							maxActiveWallClockMs: 0,
							maxEstimatedCostUsd: 1.0
						} satisfies RunBudget
					}
				]
			});

			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toContain('wall-clock budget exhausted');
			// The model was never called — the cap fired first.
			expect(modelCallCount).toBe(0);
		});
	});

	it('enforces maxChildWorkflows:0 and skips subagent delegation', async () => {
		// The model returns a text answer immediately (no tool calls), so the main
		// loop completes cleanly. Then delegation is attempted with
		// maxChildWorkflows:0 — the all-or-nothing guard skips spawning all three
		// child workflows, leaving budgetLedger entries empty and criticAnnotations
		// as an empty array.
		const activities = buildCapActivities(async (input: ModelCallInput) => ({
			runId: input.runId,
			model: input.model,
			message: { text: 'Done.', toolCalls: [] },
			usage: MOCK_MODEL_USAGE
		}));

		await runCapTest(activities, async () => {
			const runId = `budget-child-wf-${Date.now()}`;
			const result: AgentRunResult = await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-cap',
						runId,
						message: 'do something',
						delegateSubagents: true,
						budget: {
							maxModelCalls: 10,
							maxToolCalls: 20,
							maxChildWorkflows: 0,
							maxTokens: 100_000,
							maxActions: 30,
							maxActiveWallClockMs: 5 * 60 * 1000,
							maxEstimatedCostUsd: 1.0
						} satisfies RunBudget
					}
				]
			});

			expect(result.status).toBe('complete');
			expect(result.finalAnswer).toBe('Done.');
			// No child workflows were spawned — budget ledger has no subagent entries.
			expect(result.budgetLedger?.entries).toHaveLength(0);
			// Critic annotations are empty because the critic subagent was not run.
			expect(result.criticAnnotations).toEqual([]);
		});
	});
});
