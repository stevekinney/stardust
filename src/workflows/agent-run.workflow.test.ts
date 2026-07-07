import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTimeSkippingEnvironment } from './test-environment';
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
import {
	getAgentRunStateQuery,
	interruptRunSignal,
	resolveApprovalUpdate,
	steeringSignal
} from './approval-contracts';

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
		retry: { maximumAttempts: 1 },
		idempotencyBehavior: 'key-required'
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
		startedRuns: Array<{
			sessionId: string;
			runId: string;
			message: string;
			model?: string;
			budget?: RunBudget;
		}>;
		completedRuns: Array<{
			sessionId: string;
			runId: string;
			status: 'complete' | 'failed' | 'cancelled';
			finalAnswer: string;
			usage?: ModelUsage;
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

		async recordRunStarted(input: {
			sessionId: string;
			runId: string;
			message: string;
			model?: string;
			budget?: RunBudget;
		}) {
			activityState.startedRuns.push(input);
		},

		async recordRunCompleted(input: {
			sessionId: string;
			runId: string;
			status: 'complete' | 'failed' | 'cancelled';
			finalAnswer: string;
			usage?: ModelUsage;
		}) {
			activityState.completedRuns.push(input);
		},

		async recordSubagentStarted() {},
		async recordSubagentCompleted() {},
		async writeMemoryCandidate(input: { layer: 'session' | 'durable' | 'action_sensitive' }) {
			return { id: `${input.layer}-candidate` };
		},
		async searchMemory(): Promise<[]> {
			return [];
		},
		async cancelSandboxSession(): Promise<void> {}
	};

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
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
			// The status flips before the recordApprovalRequest activity returns
			// the approval card, so poll until pendingApproval is populated too —
			// otherwise a query landing in that window sees the status without it.
			let state = await handle.query(getAgentRunStateQuery);
			for (
				let i = 0;
				i < 10 && !(state.status === 'waiting_approval' && state.pendingApproval);
				i++
			) {
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

	it('emits an action_sensitive candidate when a tool is approved with remember: true', async () => {
		await runWithWorkers(async () => {
			const runId = `approval-remember-${Date.now()}`;
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
				args: [{ approvalId, action: 'approve', remember: true }]
			});
			const result = await handle.result();

			expect(result.status).toBe('complete');
			// action_sensitive candidate written via the remember=true approval path.
			expect(result.memoryRefs).toContain('action_sensitive-candidate');
			// session summary candidate always written at end of run.
			expect(result.memoryRefs).toContain('session-candidate');
		});
	});

	it('emits an action_sensitive candidate when action is remember (tool is not executed)', async () => {
		// Regression guard for task 4a9ded81: the 'remember' action sets
		// terminalState='remembered', causing handleToolCall to return
		// { kind: 'terminal' } and skipping the post-executed memory write.
		// The fix moves the remember check above the terminal early-return so the
		// action_sensitive candidate is always written when remember===true.
		await runWithWorkers(async () => {
			const runId = `approval-remember-action-${Date.now()}`;
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
				args: [{ approvalId, action: 'remember' }]
			});
			const result = await handle.result();

			// The 'remember' action does NOT execute the tool.
			expect(activityState.executions).toHaveLength(0);
			expect(result.status).toBe('complete');
			// An action_sensitive candidate MUST be written even on the terminal path.
			expect(result.memoryRefs).toContain('action_sensitive-candidate');
		});
	});

	it('forwards resolved model, default budget, and accumulated usage to observability activities', async () => {
		// Regression guard for task 7c867cdf: the workflow must pass model/budget
		// to recordRunStarted and grand-total usage to recordRunCompleted. Reverting
		// either call site would cause these assertions to fail.
		await runWithWorkers(async () => {
			const runId = `obs-wiring-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-001',
						runId,
						message: 'write the file',
						approvalTtlMs: 60_000
						// No model/budget specified → workflow uses DEFAULT_MODEL / DEFAULT_RUN_BUDGET
					}
				]
			});

			// Wait for the workflow to park in waiting_approval after the first model
			// call (which returns a tool_use block per the callModel mock above).
			const approvalId = `${runId}:tool-call-001:approval`;
			for (let i = 0; i < 10; i++) {
				const state = await handle.query(getAgentRunStateQuery);
				if (state.pendingApproval?.approvalId === approvalId) break;
				await env.sleep(100);
			}

			// Send a deny to bring the run to completion via the terminal path.
			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'deny', reason: 'stop for test' }]
			});
			await handle.result();

			// Verify recordRunStarted received the resolved model and default budget.
			expect(activityState.startedRuns).toHaveLength(1);
			expect(activityState.startedRuns[0].model).toBe('claude-sonnet-4-5-20250929');
			expect(activityState.startedRuns[0].budget).toBeDefined();
			expect(activityState.startedRuns[0].budget?.maxModelCalls).toBe(10);

			// Verify recordRunCompleted received the accumulated usage (one model call
			// returned MOCK_MODEL_USAGE; the terminal deny path forwards totalUsage).
			expect(activityState.completedRuns).toHaveLength(1);
			expect(activityState.completedRuns[0].usage).toEqual(MOCK_MODEL_USAGE);
		});
	});

	it('sets idempotencyKey on the tool call delivered to executeTool as runId:toolCallId', async () => {
		// Regression guard for the idempotencyKey wiring fix: the workflow must
		// include idempotencyKey in the ToolCallInput it delivers to executeTool
		// so the registry can route key-required tools through executeWithIdempotency.
		// Without the fix at agent-run.workflow.ts:765-769 this assertion fails.
		await runWithWorkers(async () => {
			const runId = `idem-key-${Date.now()}`;
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
				args: [{ approvalId, action: 'approve', remember: false }]
			});
			await handle.result();

			// The executeTool activity must receive the idempotency key wired as
			// `${runId}:${toolCallId}` where toolCallId is 'tool-call-001'.
			expect(activityState.executions).toHaveLength(1);
			expect(activityState.executions[0].call.idempotencyKey).toBe(`${runId}:tool-call-001`);
		});
	});
});

// ── Memory writeback suite ────────────────────────────────────────────────────

/**
 * Tests that:
 * 1. The workflow returns the actual candidate id from `writeMemoryCandidate` in
 *    `result.memoryRefs`, not a fabricated string.
 * 2. When `writeMemoryCandidate` fails, `result.memoryWriteErrors` is non-empty
 *    and `result.memoryRefs` does not contain any fabricated refs.
 */
describe('agentRunWorkflow memory writeback', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	/**
	 * Runs the workflow with the given activities and returns the result.
	 * Uses a simple callModel that returns a final answer immediately (no tools).
	 */
	async function runMemoryTest(activities: {
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
		writeMemoryCandidate(input: {
			sessionId: string;
			runId: string;
			layer: 'session' | 'durable' | 'action_sensitive';
			content: string;
			tags?: string[];
			reason?: string | null;
		}): Promise<{ id: string }>;
		searchMemory(): Promise<[]>;
		cancelSandboxSession(): Promise<void>;
	}): Promise<AgentRunResult> {
		const runId = `mem-test-${Date.now()}`;
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

		const task = orchestrator.runUntil(
			env.client.workflow
				.start('agentRunWorkflow', {
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					workflowId: `agent-run:${runId}`,
					args: [{ sessionKey: 'mem-session', runId, message: 'hello' }]
				})
				.then((handle) => handle.result())
		);
		const [result] = await Promise.all([
			task,
			tools.runUntil(task.catch(() => undefined)),
			sandbox.runUntil(task.catch(() => undefined)),
			model.runUntil(task.catch(() => undefined)),
			memory.runUntil(task.catch(() => undefined))
		]);
		return result;
	}

	/** Base activities — simple final answer, no tools. */
	function buildBaseActivities(): Parameters<typeof runMemoryTest>[0] {
		return {
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				return {
					runId: input.runId,
					model: input.model ?? 'test-model',
					message: { text: 'Hello from the model.', toolCalls: [] },
					usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0001 }
				};
			},
			async evaluateToolCallPolicy(): Promise<ToolPolicyDecision> {
				return {
					status: 'allowed',
					tool: {
						name: 'noop',
						description: '',
						inputSchema: {},
						metadata: {
							risk: 'low',
							requiresApproval: false,
							taskQueue: TASK_QUEUE_SANDBOX,
							timeoutMs: 5000,
							retry: { maximumAttempts: 1 },
							idempotencyBehavior: 'safe'
						}
					}
				};
			},
			async recordApprovalRequest(): Promise<ApprovalCardState> {
				throw ApplicationFailure.nonRetryable('Should not be called in memory writeback test');
			},
			async recordApprovalResolution(): Promise<ApprovalResolution> {
				throw ApplicationFailure.nonRetryable('Should not be called in memory writeback test');
			},
			async executeTool(
				input: ToolExecutionInput & { approved?: boolean }
			): Promise<ToolExecutionResult> {
				return {
					callId: input.call.id,
					toolName: input.call.name,
					outcome: 'success',
					content: {}
				};
			},
			async persistToolResult(): Promise<void> {},
			async recordRunStarted(): Promise<void> {},
			async recordRunCompleted(): Promise<void> {},
			async recordSubagentStarted(): Promise<void> {},
			async recordSubagentCompleted(): Promise<void> {},
			async writeMemoryCandidate() {
				return { id: 'expected-candidate-id' };
			},
			async searchMemory(): Promise<[]> {
				return [];
			},
			async cancelSandboxSession(): Promise<void> {}
		};
	}

	it('returns the actual candidate id from writeMemoryCandidate in memoryRefs', async () => {
		const result = await runMemoryTest(buildBaseActivities());

		expect(result.status).toBe('complete');
		expect(result.memoryRefs).toContain('expected-candidate-id');
	});

	it('records write failures in memoryWriteErrors and omits fake refs when writeMemoryCandidate rejects', async () => {
		const failingActivities = {
			...buildBaseActivities(),
			async writeMemoryCandidate(): Promise<{ id: string }> {
				throw ApplicationFailure.nonRetryable('simulated write failure');
			}
		};

		const result = await runMemoryTest(failingActivities);

		expect(result.status).toBe('complete');
		// No fake ref must appear — memoryRefs should be empty or absent.
		expect((result.memoryRefs ?? []).length).toBe(0);
		// The failure must be visible in memoryWriteErrors.
		expect(result.memoryWriteErrors).toBeDefined();
		expect(result.memoryWriteErrors!.length).toBeGreaterThan(0);
	});
});

// ── Steering suite ────────────────────────────────────────────────────────────

/**
 * Tests that:
 * 1. Steering messages injected via `steeringSignal` are captured in the next
 *    `callModel` input and absent in the first / subsequent calls (drained once).
 * 2. Memory retrieval (`searchMemory`) is called with the current turn's message
 *    as the query, and the returned notes flow to `callModel.memoryNotes`.
 *
 * The approval-gate synchronisation pattern is reused: the model returns a
 * tool_use on the first call, parking the workflow in `waiting_approval`.
 * The test can send signals / inspect state in that window before approving.
 */
describe('agentRunWorkflow steering', () => {
	let env: TestWorkflowEnvironment;

	/** Per-call capture of ModelCallInput.steeringMessages (undefined = not present). */
	const capturedSteeringPerCall: Array<string[] | undefined> = [];
	/** Per-call capture of ModelCallInput.memoryNotes (undefined = not present). */
	const capturedMemoryPerCall: Array<unknown[] | undefined> = [];
	const capturedModelCallIds: string[] = [];
	/** All queries received by searchMemory across the run. */
	const capturedSearchMemoryQueries: string[] = [];

	const modelCallCounts = new Map<string, number>();

	/**
	 * A known memory note returned by `searchMemory` in the memory retrieval test.
	 * Used to assert that retrieved notes are forwarded to `callModel.memoryNotes`.
	 */
	const KNOWN_MEMORY_NOTE = {
		id: 'mem-test-001',
		layer: 'durable',
		content: 'User prefers concise answers.',
		tags: ['preferences']
	};

	function resetCaptures() {
		capturedSteeringPerCall.length = 0;
		capturedMemoryPerCall.length = 0;
		capturedModelCallIds.length = 0;
		capturedSearchMemoryQueries.length = 0;
		modelCallCounts.clear();
	}

	/** Base activities used by the two-model-call tests. */
	const steeringTestActivities = {
		async callModel(input: ModelCallInput): Promise<ModelCallResult> {
			const count = (modelCallCounts.get(input.runId) ?? 0) + 1;
			modelCallCounts.set(input.runId, count);
			capturedSteeringPerCall.push(input.steeringMessages);
			capturedMemoryPerCall.push(input.memoryNotes);
			capturedModelCallIds.push(input.modelCallId);

			const base = {
				runId: input.runId,
				model: input.model ?? 'claude-sonnet-4-5-20250929',
				usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0001 } as ModelUsage
			};

			if (count === 1) {
				// First call returns a tool_use to trigger the approval flow.
				return {
					...base,
					message: {
						text: '',
						toolCalls: [
							{
								id: 'steer-tool-001',
								name: 'workspace.writeFile',
								input: { path: 'x.txt', content: 'y' }
							}
						]
					}
				};
			}
			// Second call (post-approval) returns the final text answer.
			return { ...base, message: { text: 'Done.', toolCalls: [] } };
		},

		async searchMemory(input: {
			sessionId: string;
			query: string;
		}): Promise<(typeof KNOWN_MEMORY_NOTE)[]> {
			capturedSearchMemoryQueries.push(input.query);
			return [KNOWN_MEMORY_NOTE];
		},

		async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
			return {
				status: 'approval_required',
				tool: {
					name: input.call.name,
					description: 'Write a file.',
					inputSchema: {},
					metadata: {
						risk: 'medium' as const,
						requiresApproval: true,
						taskQueue: TASK_QUEUE_SANDBOX,
						timeoutMs: 15_000,
						retry: { maximumAttempts: 1 },
						idempotencyBehavior: 'key-required' as const
					}
				},
				policyVersion: '2026-06-27'
			};
		},

		async recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState> {
			return {
				...input,
				argsHash: 'hash-steer',
				createdAt: '2026-06-27T00:00:00.000Z',
				status: 'pending'
			};
		},

		async recordApprovalResolution(
			input: RecordApprovalResolutionInput
		): Promise<ApprovalResolution> {
			return {
				approvalId: input.approvalId,
				action: input.action,
				terminalState: 'approved',
				canonicalArguments: { path: 'x.txt', content: 'y' },
				proposedArguments: { path: 'x.txt', content: 'y' },
				remember: false,
				actor: input.actor,
				resolvedAt: '2026-06-27T01:00:00.000Z'
			};
		},

		async executeTool(
			input: ToolExecutionInput & { approved?: boolean }
		): Promise<ToolExecutionResult> {
			return { callId: input.call.id, toolName: input.call.name, outcome: 'success', content: {} };
		},

		async persistToolResult(): Promise<void> {},
		async recordRunStarted(): Promise<void> {},
		async recordRunCompleted(): Promise<void> {},
		async recordSubagentStarted(): Promise<void> {},
		async recordSubagentCompleted(): Promise<void> {},
		async writeMemoryCandidate() {
			return { id: 'mock-candidate-id' };
		},
		async cancelSandboxSession(): Promise<void> {}
	};

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	beforeEach(() => {
		resetCaptures();
	});

	/** Spins up all five task-queue workers and runs `callback` inside the orchestrator's scope. */
	async function runSteeringWorkers<T>(
		activities: typeof steeringTestActivities,
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
		await Promise.all([
			tools.runUntil(task.catch(() => undefined)),
			sandbox.runUntil(task.catch(() => undefined)),
			model.runUntil(task.catch(() => undefined)),
			memory.runUntil(task.catch(() => undefined))
		]);
		return task;
	}

	it('memory retrieval is called with the current turn message as query, and notes flow to callModel', async () => {
		const runId = `memory-${Date.now()}`;

		const result = await runSteeringWorkers(steeringTestActivities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-memory',
						runId,
						message: 'do some work',
						approvalTtlMs: 60_000
					}
				]
			});

			// Wait for waiting_approval (first model call done, searchMemory already called).
			let state = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 20 && state.status !== 'waiting_approval'; i++) {
				await env.sleep(50);
				state = await handle.query(getAgentRunStateQuery);
			}

			// Approve so the run completes.
			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [
					{
						approvalId: `${runId}:steer-tool-001:approval`,
						action: 'approve',
						remember: false
					}
				]
			});

			return handle.result();
		});

		expect(result.status).toBe('complete');

		// searchMemory was called before each model call, using input.message as the query.
		expect(capturedSearchMemoryQueries.length).toBeGreaterThanOrEqual(1);
		expect(capturedSearchMemoryQueries[0]).toBe('do some work');

		// The known note returned by searchMemory must appear in every callModel input.
		expect(capturedMemoryPerCall[0]).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: 'mem-test-001', layer: 'durable' })])
		);
		expect(capturedMemoryPerCall[1]).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: 'mem-test-001', layer: 'durable' })])
		);
	});

	it('steering signal sent during waiting_approval appears in the next callModel input and is absent in the first', async () => {
		const runId = `steering-${Date.now()}`;

		const result = await runSteeringWorkers(steeringTestActivities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'session-steer',
						runId,
						message: 'do some work',
						approvalTtlMs: 60_000
					}
				]
			});

			const approvalId = `${runId}:steer-tool-001:approval`;
			// Wait for the workflow to park on the exact approval produced by the first model call.
			let state = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 20 && state.pendingApproval?.approvalId !== approvalId; i++) {
				await env.sleep(50);
				state = await handle.query(getAgentRunStateQuery);
			}
			expect(state.status).toBe('waiting_approval');
			expect(state.pendingApproval?.approvalId).toBe(approvalId);

			// Send steering signal while the workflow is waiting, then approve immediately.
			const signalAccepted = handle.signal(steeringSignal, 'focus on the budget');
			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [
					{
						approvalId,
						action: 'approve',
						remember: false
					}
				]
			});
			await signalAccepted;

			return handle.result();
		});

		expect(result.status).toBe('complete');
		expect(result.finalAnswer).toBe('Done.');

		// Two model calls happened.
		expect(capturedSteeringPerCall).toHaveLength(2);

		// First call: no steering messages (signal sent after call 1 started).
		expect(capturedSteeringPerCall[0]).toBeUndefined();

		// Second call: steering message present (drained from buffer before call 2).
		expect(capturedSteeringPerCall[1]).toEqual(['focus on the budget']);
		expect(capturedModelCallIds).toEqual([`${runId}:model-call-1`, `${runId}:model-call-2`]);
	});

	it('steering message is drained exactly once — absent in the third model call', async () => {
		// Local per-test captures to isolate from the shared describe-level arrays.
		const perTestSteering: Array<string[] | undefined> = [];
		const localCounts = new Map<string, number>();

		const threeCallActivities = {
			...steeringTestActivities,

			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				const count = (localCounts.get(input.runId) ?? 0) + 1;
				localCounts.set(input.runId, count);
				perTestSteering.push(input.steeringMessages);

				const base = {
					runId: input.runId,
					model: input.model ?? 'claude-sonnet-4-5-20250929',
					usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0001 } as ModelUsage
				};

				if (count === 1) {
					// Call 1: tool_use — triggers first approval gate.
					return {
						...base,
						message: {
							text: '',
							toolCalls: [{ id: 'drain-001', name: 'workspace.writeFile', input: {} }]
						}
					};
				}
				if (count === 2) {
					// Call 2: another tool_use — triggers second approval gate (no new signal).
					return {
						...base,
						message: {
							text: '',
							toolCalls: [{ id: 'drain-002', name: 'workspace.writeFile', input: {} }]
						}
					};
				}
				// Call 3: final text answer — no steering expected.
				return { ...base, message: { text: 'All done.', toolCalls: [] } };
			},

			// Disable memory retrieval for this test to keep captures clean.
			async searchMemory(): Promise<[]> {
				return [];
			}
		};

		const runId = `drain-${Date.now()}`;

		const result = await runSteeringWorkers(
			threeCallActivities as typeof steeringTestActivities,
			async () => {
				const handle = await env.client.workflow.start('agentRunWorkflow', {
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					workflowId: `agent-run:${runId}`,
					args: [
						{
							sessionKey: 'session-drain',
							runId,
							message: 'drain me',
							approvalTtlMs: 60_000
						}
					]
				});

				// ── Wait for first approval gate (call 1 produced tool drain-001). ─
				let state = await handle.query(getAgentRunStateQuery);
				for (let i = 0; i < 20 && state.status !== 'waiting_approval'; i++) {
					await env.sleep(50);
					state = await handle.query(getAgentRunStateQuery);
				}
				expect(state.status).toBe('waiting_approval');

				// Send the steering message before call 2.
				await handle.signal(steeringSignal, 'steer before call 2');

				// Approve drain-001.
				await handle.executeUpdate(resolveApprovalUpdate, {
					args: [
						{
							approvalId: `${runId}:drain-001:approval`,
							action: 'approve',
							remember: false
						}
					]
				});

				// ── Wait for second approval gate (call 2 produced tool drain-002). ─
				state = await handle.query(getAgentRunStateQuery);
				for (let i = 0; i < 20 && state.status !== 'waiting_approval'; i++) {
					await env.sleep(50);
					state = await handle.query(getAgentRunStateQuery);
				}
				expect(state.status).toBe('waiting_approval');

				// Do NOT send a new signal — drain must be empty for call 3.
				await handle.executeUpdate(resolveApprovalUpdate, {
					args: [
						{
							approvalId: `${runId}:drain-002:approval`,
							action: 'approve',
							remember: false
						}
					]
				});

				return handle.result();
			}
		);

		expect(result.status).toBe('complete');
		expect(result.finalAnswer).toBe('All done.');
		expect(perTestSteering).toHaveLength(3);

		// Call 1: no steering (signal not yet sent).
		expect(perTestSteering[0]).toBeUndefined();
		// Call 2: steering present (buffered between call 1 approval and call 2).
		expect(perTestSteering[1]).toEqual(['steer before call 2']);
		// Call 3: steering absent — buffer was drained exactly once; no new signal sent.
		expect(perTestSteering[2]).toBeUndefined();
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
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('runs research, code, and critic subagents; reconciles real model usage in the budget ledger', async () => {
		// The subagent model mock always returns a text answer (no tool calls).
		// Research and code subagents each make one model call with MOCK_MODEL_USAGE.
		// The critic makes no model call and returns zero usage.
		const capturedModelCallIds: string[] = [];
		const subagentTestActivities = {
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				capturedModelCallIds.push(input.modelCallId);
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
			async writeMemoryCandidate() {
				return { id: 'mock-candidate-id' };
			},
			async searchMemory(): Promise<[]> {
				return [];
			},
			async cancelSandboxSession(): Promise<void> {}
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
		// cancelSandboxSession is dispatched to TASK_QUEUE_SANDBOX via the
		// workflow's finally block — this worker must be present so the activity
		// doesn't time out and fail the workflow.
		const sandbox = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_SANDBOX,
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
			expect(capturedModelCallIds).toHaveLength(3);
			expect(capturedModelCallIds).toEqual(
				expect.arrayContaining([
					`${runId}:model-call-1`,
					`${runId}:research:model-call-1`,
					`${runId}:code:model-call-1`
				])
			);
		});

		const toolsTask = tools.runUntil(task.catch(() => undefined));
		const sandboxTask = sandbox.runUntil(task.catch(() => undefined));
		const modelTask = model.runUntil(task.catch(() => undefined));
		const memoryTask = memory.runUntil(task.catch(() => undefined));
		await Promise.all([task, toolsTask, sandboxTask, modelTask, memoryTask]);
	});
});

// ── Delegate tool suite ───────────────────────────────────────────────────────

describe('agentRunWorkflow delegate tools', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	const delegateTool: ToolManifestEntry = {
		name: 'delegate.code',
		description: 'Launch a code subagent.',
		inputSchema: {},
		metadata: {
			risk: 'high',
			requiresApproval: true,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			timeoutMs: 120_000,
			retry: { maximumAttempts: 1 },
			idempotencyBehavior: 'key-required'
		}
	};

	type DelegateActivityState = {
		modelCalls: ModelCallInput[];
		approvalRequests: RecordApprovalRequestInput[];
		toolExecutions: ToolExecutionInput[];
		persistedToolResults: Array<{
			sessionId: string;
			runId: string;
			callId: string;
			content: unknown;
			isError: boolean;
		}>;
		startedSubagents: Array<{ subagentRunId: string; kind: string }>;
		completedSubagents: Array<{ subagentRunId: string; status: string }>;
	};

	function createDelegateActivityState(): DelegateActivityState {
		return {
			modelCalls: [],
			approvalRequests: [],
			toolExecutions: [],
			persistedToolResults: [],
			startedSubagents: [],
			completedSubagents: []
		};
	}

	function createDelegateActivities(state: DelegateActivityState) {
		const parentModelCounts = new Map<string, number>();
		return {
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				state.modelCalls.push(input);
				const base = {
					runId: input.runId,
					model: input.model ?? 'claude-sonnet-4-5-20250929',
					usage: MOCK_MODEL_USAGE
				};

				if (input.runId.includes(':delegate-tool-001:code')) {
					return { ...base, message: { text: 'Code subagent answer.', toolCalls: [] } };
				}

				const count = (parentModelCounts.get(input.runId) ?? 0) + 1;
				parentModelCounts.set(input.runId, count);
				if (count === 1) {
					return {
						...base,
						message: {
							text: '',
							toolCalls: [
								{
									id: 'delegate-tool-001',
									name: 'delegate.code',
									input: { prompt: 'Implement the focused helper.', maxTokens: 321 }
								}
							]
						}
					};
				}
				return { ...base, message: { text: 'Parent final answer.', toolCalls: [] } };
			},
			async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
				return {
					status: 'approval_required',
					tool: { ...delegateTool, name: input.call.name },
					policyVersion: '2026-06-30'
				};
			},
			async recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState> {
				state.approvalRequests.push(input);
				return {
					...input,
					argsHash: 'delegate-hash',
					createdAt: '2026-06-30T00:00:00.000Z',
					status: 'pending'
				};
			},
			async recordApprovalResolution(
				input: RecordApprovalResolutionInput
			): Promise<ApprovalResolution> {
				const request = state.approvalRequests.find(
					(candidate) => candidate.approvalId === input.approvalId
				);
				if (!request) throw ApplicationFailure.nonRetryable(`Missing request ${input.approvalId}`);
				return {
					approvalId: input.approvalId,
					action: input.action,
					terminalState: input.action === 'approve' ? 'approved' : 'denied',
					canonicalArguments: request.proposedArguments,
					proposedArguments: request.proposedArguments,
					remember: false,
					actor: input.actor,
					resolvedAt: '2026-06-30T00:01:00.000Z'
				};
			},
			async executeTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
				state.toolExecutions.push(input);
				return {
					callId: input.call.id,
					toolName: input.call.name,
					outcome: 'success',
					content: { shouldNotRunForDelegate: true }
				};
			},
			async persistToolResult(input: {
				sessionId: string;
				runId: string;
				callId: string;
				content: unknown;
				isError: boolean;
			}): Promise<void> {
				state.persistedToolResults.push(input);
			},
			async recordRunStarted(): Promise<void> {},
			async recordRunCompleted(): Promise<void> {},
			async recordSubagentStarted(input: { subagentRunId: string; kind: string }): Promise<void> {
				state.startedSubagents.push(input);
			},
			async recordSubagentCompleted(input: {
				subagentRunId: string;
				status: string;
			}): Promise<void> {
				state.completedSubagents.push(input);
			},
			async writeMemoryCandidate() {
				return { id: 'delegate-memory-candidate' };
			},
			async searchMemory(): Promise<[]> {
				return [];
			},
			async cancelSandboxSession(): Promise<void> {}
		};
	}

	async function runDelegateWorkers<T>(
		activities: ReturnType<typeof createDelegateActivities>,
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

	it('requires approval, launches exactly one code child workflow, and persists the tool result', async () => {
		const state = createDelegateActivityState();
		const activities = createDelegateActivities(state);
		const runId = `delegate-code-${Date.now()}`;
		const result = await runDelegateWorkers(activities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'delegate-session',
						runId,
						message: 'delegate code work',
						approvalTtlMs: 60_000
					}
				]
			});

			const approvalId = `${runId}:delegate-tool-001:approval`;
			let runState = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 20 && runState.pendingApproval?.approvalId !== approvalId; i++) {
				await env.sleep(50);
				runState = await handle.query(getAgentRunStateQuery);
			}
			expect(runState.status).toBe('waiting_approval');

			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'approve', remember: false }]
			});
			return handle.result();
		});

		const subagentRunId = `${runId}:delegate-tool-001:code`;
		expect(result.status).toBe('complete');
		expect(result.finalAnswer).toBe('Parent final answer.');
		expect(state.approvalRequests).toHaveLength(1);
		expect(state.toolExecutions).toHaveLength(0);
		expect(state.startedSubagents).toEqual([
			expect.objectContaining({ subagentRunId, kind: 'code' })
		]);
		expect(state.completedSubagents).toEqual([
			expect.objectContaining({ subagentRunId, status: 'complete' })
		]);
		expect(state.persistedToolResults).toEqual([
			expect.objectContaining({
				callId: 'delegate-tool-001',
				content: {
					subagentRunId,
					kind: 'code',
					finalAnswer: 'Code subagent answer.'
				},
				isError: false
			})
		]);
		expect(result.budgetLedger?.entries).toEqual([
			expect.objectContaining({
				workflowId: `agent-run:${subagentRunId}`,
				laneId: subagentRunId,
				label: 'Code',
				usage: MOCK_MODEL_USAGE
			})
		]);
	});

	it('uses a retry-stable child workflow id and passes the delegate prompt into model context', async () => {
		const state = createDelegateActivityState();
		const activities = createDelegateActivities(state);
		const runId = `delegate-prompt-${Date.now()}`;
		await runDelegateWorkers(activities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [
					{
						sessionKey: 'delegate-session',
						runId,
						message: 'delegate code work',
						approvalTtlMs: 60_000
					}
				]
			});

			const approvalId = `${runId}:delegate-tool-001:approval`;
			let runState = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 20 && runState.pendingApproval?.approvalId !== approvalId; i++) {
				await env.sleep(50);
				runState = await handle.query(getAgentRunStateQuery);
			}
			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'approve', remember: false }]
			});
			return handle.result();
		});

		const subagentRunId = `${runId}:delegate-tool-001:code`;
		const subagentModelCall = state.modelCalls.find((call) => call.runId === subagentRunId);
		expect(subagentModelCall).toEqual(
			expect.objectContaining({
				runId: subagentRunId,
				modelCallId: `${subagentRunId}:model-call-1`,
				steeringMessages: ['Implement the focused helper.'],
				maxTokens: 321
			})
		);
		expect(state.startedSubagents.map((entry) => entry.subagentRunId)).toEqual([subagentRunId]);
	});

	it('respects child workflow and action budgets before launching a delegate', async () => {
		for (const [runLabel, budget] of [
			[
				'child-budget',
				{
					maxModelCalls: 10,
					maxToolCalls: 10,
					maxChildWorkflows: 0,
					maxTokens: 1_000,
					maxActions: 10,
					maxActiveWallClockMs: 60_000,
					maxEstimatedCostUsd: 1
				}
			],
			[
				'action-budget',
				{
					maxModelCalls: 10,
					maxToolCalls: 10,
					maxChildWorkflows: 3,
					maxTokens: 1_000,
					maxActions: 1,
					maxActiveWallClockMs: 60_000,
					maxEstimatedCostUsd: 1
				}
			]
		] as const) {
			const state = createDelegateActivityState();
			const activities = createDelegateActivities(state);
			const runId = `delegate-${runLabel}-${Date.now()}`;
			const result = await runDelegateWorkers(activities, () =>
				env.client.workflow.execute('agentRunWorkflow', {
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					workflowId: `agent-run:${runId}`,
					args: [
						{
							sessionKey: 'delegate-session',
							runId,
							message: 'delegate code work',
							budget
						}
					]
				})
			);

			expect(result.status).toBe('complete');
			expect(state.approvalRequests).toHaveLength(0);
			expect(state.startedSubagents).toHaveLength(0);
			expect(state.persistedToolResults).toHaveLength(0);
			expect(result.finalAnswer).toMatch(
				runLabel === 'child-budget' ? /child workflow budget exhausted/ : /action budget exhausted/
			);
		}
	});
});

// ── Timer wait suite ────────────────────────────────────────────────────────────

/**
 * These tests exercise `timer.wait`: a durable wait intercepted by the
 * orchestrator workflow itself (mirroring how `delegate.parallel` is
 * intercepted before reaching a tool activity) rather than dispatched through
 * `executeTool`. `timer.wait` never requires approval, so `evaluateToolCallPolicy`
 * returns `allowed` directly.
 */
describe('agentRunWorkflow timer.wait', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	const timerTool: ToolManifestEntry = {
		name: 'timer.wait',
		description: 'Durably wait before continuing.',
		inputSchema: {},
		metadata: {
			risk: 'low',
			requiresApproval: false,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			timeoutMs: 10_000,
			retry: { maximumAttempts: 2 },
			idempotencyBehavior: 'safe'
		}
	};

	type TimerActivityState = {
		toolExecutions: ToolExecutionInput[];
		persistedToolResults: Array<{
			sessionId: string;
			runId: string;
			callId: string;
			content: unknown;
			isError: boolean;
		}>;
		/**
		 * Number of `evaluateToolCallPolicy` calls observed so far. `timer.wait`
		 * never requires approval, so there is no `waiting_approval` query state to
		 * poll on the way to the durable `condition()` wait (unlike the approval
		 * suites). Polling this counter instead confirms the workflow has actually
		 * reached — and is durably parked in — the timer wait before a test
		 * cancels it, rather than guessing with a fixed sleep.
		 */
		policyEvaluations: number;
	};

	function createTimerActivityState(): TimerActivityState {
		return { toolExecutions: [], persistedToolResults: [], policyEvaluations: 0 };
	}

	/** `toolInput` is the raw `timer.wait` tool-call arguments the mocked model returns. */
	function createTimerActivities(state: TimerActivityState, toolInput: unknown) {
		const modelCallCounts = new Map<string, number>();
		return {
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				const count = (modelCallCounts.get(input.runId) ?? 0) + 1;
				modelCallCounts.set(input.runId, count);
				const base = {
					runId: input.runId,
					model: input.model ?? 'claude-sonnet-4-5-20250929',
					usage: MOCK_MODEL_USAGE
				};
				if (count === 1) {
					return {
						...base,
						message: {
							text: '',
							toolCalls: [{ id: 'timer-tool-001', name: 'timer.wait', input: toolInput }]
						}
					};
				}
				return { ...base, message: { text: 'Checked back in.', toolCalls: [] } };
			},
			async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
				state.policyEvaluations++;
				return { status: 'allowed', tool: { ...timerTool, name: input.call.name } };
			},
			async recordApprovalRequest(): Promise<ApprovalCardState> {
				throw ApplicationFailure.nonRetryable('timer.wait must not require approval');
			},
			async recordApprovalResolution(): Promise<ApprovalResolution> {
				throw ApplicationFailure.nonRetryable('timer.wait must not require approval');
			},
			async executeTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
				state.toolExecutions.push(input);
				return {
					callId: input.call.id,
					toolName: input.call.name,
					outcome: 'success',
					content: { shouldNotRunForTimer: true }
				};
			},
			async persistToolResult(input: {
				sessionId: string;
				runId: string;
				callId: string;
				content: unknown;
				isError: boolean;
			}): Promise<void> {
				state.persistedToolResults.push(input);
			},
			async recordRunStarted(): Promise<void> {},
			async recordRunCompleted(): Promise<void> {},
			async recordSubagentStarted(): Promise<void> {},
			async recordSubagentCompleted(): Promise<void> {},
			async writeMemoryCandidate() {
				return { id: 'timer-memory-candidate' };
			},
			async searchMemory(): Promise<[]> {
				return [];
			},
			async cancelSandboxSession(): Promise<void> {}
		};
	}

	async function runTimerWorkers<T>(
		activities: ReturnType<typeof createTimerActivities>,
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

	it('durably waits out the full duration, never dispatches a tool activity, and persists a completed result', async () => {
		const state = createTimerActivityState();
		const activities = createTimerActivities(state, {
			durationMs: 60_000,
			reason: 'check deploy status'
		});
		const runId = `timer-wait-full-${Date.now()}`;

		const result = await runTimerWorkers(activities, () =>
			env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey: 'timer-session', runId, message: 'wait then check' }]
			})
		);

		expect(result.status).toBe('complete');
		expect(result.finalAnswer).toBe('Checked back in.');
		expect(state.toolExecutions).toHaveLength(0);
		expect(state.persistedToolResults).toEqual([
			expect.objectContaining({
				callId: 'timer-tool-001',
				content: { completed: true, durationMs: 60_000, reason: 'check deploy status' },
				isError: false
			})
		]);
	});

	/**
	 * Polls until `evaluateToolCallPolicy` has actually run — a fixed sleep
	 * raced the callModel/evaluateToolCallPolicy round trip often enough to be
	 * flaky (sometimes landing an interrupt/cancel before the workflow ever
	 * reached the durable `condition()` wait). This confirms the workflow is
	 * durably parked in the wait before a test interrupts or cancels it.
	 */
	async function waitUntilParkedInTimerWait(state: TimerActivityState): Promise<void> {
		for (let i = 0; i < 20 && state.policyEvaluations === 0; i++) {
			await env.sleep(50);
		}
		expect(state.policyEvaluations).toBeGreaterThan(0);
	}

	it('interruptRunSignal ends the wait early, persists a completed:false result through the ordinary path, and the run ends cancelled', async () => {
		// Regression note: an earlier version of this test relied on a hard
		// Temporal cancellation (`handle.cancel()`) and asserted a durably
		// persisted `{ completed: false, waitedApproximatelyMs }` tool result.
		// That required scheduling a *new* activity call while the run's
		// cancellation was already tearing down the workflow scope, which proved
		// unreliable under this time-skipping test harness (flaky hangs). The
		// in-band `interruptRunSignal` flag this test exercises instead ends the
		// `condition()` wait through *ordinary* control flow — no cancellation
		// involved at all — so persisting the partial result and then ending the
		// run has no such race (see `executeTimerWaitToolCall`'s doc comment).
		const state = createTimerActivityState();
		const activities = createTimerActivities(state, {
			durationMs: 24 * 60 * 60 * 1000,
			reason: 'long wait'
		});
		const runId = `timer-wait-interrupt-${Date.now()}`;

		const result = await runTimerWorkers(activities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey: 'timer-session', runId, message: 'wait a day' }]
			});

			await waitUntilParkedInTimerWait(state);

			await handle.signal(interruptRunSignal);
			// Graceful path: the run ends normally (result resolves, doesn't reject).
			return handle.result();
		});

		expect(result.status).toBe('cancelled');
		expect(state.toolExecutions).toHaveLength(0);
		expect(state.persistedToolResults).toEqual([
			expect.objectContaining({
				callId: 'timer-tool-001',
				isError: false,
				content: {
					completed: false,
					waitedApproximatelyMs: expect.any(Number),
					durationMs: 24 * 60 * 60 * 1000,
					reason: 'long wait'
				}
			})
		]);
	});

	it('a hard cancellation without interruptRunSignal still ends the run cancelled, with no partial-wait tool result', async () => {
		const state = createTimerActivityState();
		const activities = createTimerActivities(state, {
			durationMs: 24 * 60 * 60 * 1000,
			reason: 'long wait'
		});
		const runId = `timer-wait-hard-cancel-${Date.now()}`;

		await runTimerWorkers(activities, async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey: 'timer-session', runId, message: 'wait a day' }]
			});

			await waitUntilParkedInTimerWait(state);

			await handle.cancel();
			await expect(handle.result()).rejects.toThrow();
		});

		expect(state.toolExecutions).toHaveLength(0);
		expect(state.persistedToolResults).toHaveLength(0);
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
		env = await createTimeSkippingEnvironment();
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
			retry: { maximumAttempts: 1 },
			idempotencyBehavior: 'safe'
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
		writeMemoryCandidate(): Promise<{ id: string }>;
		searchMemory(): Promise<[]>;
		cancelSandboxSession(): Promise<void>;
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
			async writeMemoryCandidate() {
				return { id: 'mock-candidate-id' };
			},
			async searchMemory(): Promise<[]> {
				return [];
			},
			async cancelSandboxSession(): Promise<void> {}
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

// ── Cancel cleanup suite ───────────────────────────────────────────────────────

/**
 * Tests that `cancelSandboxSession` is invoked in the workflow's `finally`
 * block on every exit path:
 *   1. Normal completion (model returns a text answer immediately).
 *   2. Workflow-level cancellation (Temporal CancelledFailure propagates through
 *      the try block, but the nonCancellable finally still runs).
 *
 * Both cases assert that the cancelled session key recorded in `cancelledSessions`
 * matches the session key given to the workflow — proving the finally path ran.
 */
describe('agentRunWorkflow cancel cleanup', () => {
	let env: TestWorkflowEnvironment;
	const cancelledSessions: string[] = [];

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	beforeEach(() => {
		cancelledSessions.length = 0;
	});

	/** Activities used by both cleanup tests. callModel returns a final answer on the first call. */
	const cleanupActivities = {
		async callModel(input: ModelCallInput): Promise<ModelCallResult> {
			// Default: return a text answer immediately so the workflow completes normally.
			return {
				runId: input.runId,
				model: input.model ?? 'claude-sonnet-4-5-20250929',
				message: { text: 'Cleanup test done.', toolCalls: [] },
				usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.0001 } as ModelUsage
			};
		},
		async evaluateToolCallPolicy(input: { call: ToolCallInput }): Promise<ToolPolicyDecision> {
			return {
				status: 'approval_required',
				tool: {
					name: input.call.name,
					description: 'Risky tool',
					inputSchema: {},
					metadata: {
						risk: 'medium' as const,
						requiresApproval: true,
						taskQueue: TASK_QUEUE_SANDBOX,
						timeoutMs: 15_000,
						retry: { maximumAttempts: 1 },
						idempotencyBehavior: 'key-required' as const
					}
				},
				policyVersion: '2026-06-27'
			};
		},
		async recordApprovalRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState> {
			return {
				...input,
				argsHash: 'cleanup-hash',
				createdAt: '2026-06-27T00:00:00.000Z',
				status: 'pending'
			};
		},
		async recordApprovalResolution(
			input: RecordApprovalResolutionInput
		): Promise<ApprovalResolution> {
			return {
				approvalId: input.approvalId,
				action: input.action,
				terminalState: 'cancelled',
				canonicalArguments: {},
				proposedArguments: {},
				remember: false,
				actor: 'user',
				resolvedAt: '2026-06-27T01:00:00.000Z'
			};
		},
		async executeTool(
			input: ToolExecutionInput & { approved?: boolean }
		): Promise<ToolExecutionResult> {
			return { callId: input.call.id, toolName: input.call.name, outcome: 'success', content: {} };
		},
		async persistToolResult(): Promise<void> {},
		async recordRunStarted(): Promise<void> {},
		async recordRunCompleted(): Promise<void> {},
		async recordSubagentStarted(): Promise<void> {},
		async recordSubagentCompleted(): Promise<void> {},
		async writeMemoryCandidate() {
			return { id: 'cleanup-candidate-id' };
		},
		async searchMemory(): Promise<[]> {
			return [];
		},
		async cancelSandboxSession(sessionKey: string): Promise<void> {
			cancelledSessions.push(sessionKey);
		}
	};

	async function runCleanupWorkers<T>(
		activities: typeof cleanupActivities,
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
		await Promise.all([
			tools.runUntil(task.catch(() => undefined)),
			sandbox.runUntil(task.catch(() => undefined)),
			model.runUntil(task.catch(() => undefined)),
			memory.runUntil(task.catch(() => undefined))
		]);
		return task;
	}

	it('calls cancelSandboxSession in the finally path on normal workflow completion', async () => {
		const sessionKey = 'cleanup-normal-session';

		await runCleanupWorkers(cleanupActivities, async () => {
			const runId = `cleanup-normal-${Date.now()}`;
			await env.client.workflow.execute('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey, runId, message: 'hello' }]
			});
		});

		// The finally block must have recorded the session key exactly once.
		expect(cancelledSessions).toContain(sessionKey);
	});

	it('calls cancelSandboxSession in the finally path when the workflow is cancelled', async () => {
		// The callModel in the parking variant returns a tool call so the workflow
		// parks in waiting_approval — that gives us a window to cancel it while it
		// is blocked in a condition(), which is the real cancellation scenario.
		const parkingActivities = {
			...cleanupActivities,
			async callModel(input: ModelCallInput): Promise<ModelCallResult> {
				return {
					runId: input.runId,
					model: input.model ?? 'claude-sonnet-4-5-20250929',
					message: {
						text: '',
						toolCalls: [{ id: 'cancel-tool-001', name: 'workspace.writeFile', input: {} }]
					},
					usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.0001 } as ModelUsage
				};
			}
		};

		const sessionKey = 'cleanup-cancel-session';

		await runCleanupWorkers(parkingActivities, async () => {
			const runId = `cleanup-cancel-${Date.now()}`;
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey, runId, message: 'write the file', approvalTtlMs: 60_000 }]
			});

			// Wait until the workflow parks in waiting_approval.
			let state = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 10 && state.status !== 'waiting_approval'; i++) {
				await env.sleep(100);
				state = await handle.query(getAgentRunStateQuery);
			}
			expect(state.status).toBe('waiting_approval');

			// Cancel the workflow — this propagates CancelledFailure through the try
			// block. The CancellationScope.nonCancellable wrapper in the finally block
			// ensures cancelSandboxSession still runs despite the cancellation.
			await handle.cancel();

			// result() rejects because the workflow was cancelled.
			await expect(handle.result()).rejects.toThrow();
		});

		// The finally block must have recorded the session key even though the
		// workflow was cancelled (not a normal completion).
		expect(cancelledSessions).toContain(sessionKey);
	});
});

// ── Failure-status suite ───────────────────────────────────────────────────────

/**
 * Regression guard for task 250c5b44: when callModel throws an unrecoverable
 * error the run workflow must record status='failed' via recordRunCompleted
 * before propagating the error. Without the fix the status stays 'running'
 * forever and the inspector shows dead runs as Running.
 */
describe('agentRunWorkflow failure status', () => {
	let env: TestWorkflowEnvironment;

	const completedRuns: Array<{
		sessionId: string;
		runId: string;
		status: 'complete' | 'failed' | 'cancelled';
		finalAnswer: string;
		usage?: ModelUsage;
	}> = [];

	const failingActivities = {
		async callModel(): Promise<ModelCallResult> {
			throw ApplicationFailure.nonRetryable('simulated model failure');
		},
		async evaluateToolCallPolicy(): Promise<ToolPolicyDecision> {
			return {
				status: 'allowed',
				tool: {
					name: 'noop',
					description: '',
					inputSchema: {},
					metadata: {
						risk: 'low' as const,
						requiresApproval: false,
						taskQueue: TASK_QUEUE_SANDBOX,
						timeoutMs: 5000,
						retry: { maximumAttempts: 1 },
						idempotencyBehavior: 'safe' as const
					}
				}
			};
		},
		async recordApprovalRequest(): Promise<ApprovalCardState> {
			throw ApplicationFailure.nonRetryable('should not be called');
		},
		async recordApprovalResolution(): Promise<ApprovalResolution> {
			throw ApplicationFailure.nonRetryable('should not be called');
		},
		async executeTool(
			input: ToolExecutionInput & { approved?: boolean }
		): Promise<ToolExecutionResult> {
			return { callId: input.call.id, toolName: input.call.name, outcome: 'success', content: {} };
		},
		async persistToolResult(): Promise<void> {},
		async recordRunStarted(): Promise<void> {},
		async recordRunCompleted(input: {
			sessionId: string;
			runId: string;
			status: 'complete' | 'failed' | 'cancelled';
			finalAnswer: string;
			usage?: ModelUsage;
		}): Promise<void> {
			completedRuns.push(input);
		},
		async recordSubagentStarted(): Promise<void> {},
		async recordSubagentCompleted(): Promise<void> {},
		async writeMemoryCandidate(): Promise<{ id: string }> {
			return { id: 'fail-candidate' };
		},
		async searchMemory(): Promise<[]> {
			return [];
		},
		async cancelSandboxSession(): Promise<void> {}
	};

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('records status=failed via recordRunCompleted when callModel throws', async () => {
		completedRuns.length = 0;

		const runId = `fail-status-${Date.now()}`;

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
			activities: failingActivities
		});
		const sandbox = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_SANDBOX,
			activities: failingActivities
		});
		const model = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MODEL,
			activities: failingActivities
		});
		const memory = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities: failingActivities
		});

		// Start the workflow then wait for it to finish (it will throw, so catch the error).
		// The orchestrator worker runs the workflow; the other workers provide activities.
		const task = orchestrator.runUntil(async () => {
			const handle = await env.client.workflow.start('agentRunWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-run:${runId}`,
				args: [{ sessionKey: 'fail-session', runId, message: 'trigger failure' }]
			});
			// The workflow re-throws after recording failure, so result() rejects.
			await expect(handle.result()).rejects.toThrow();
		});

		await Promise.all([
			task,
			tools.runUntil(task.catch(() => undefined)),
			sandbox.runUntil(task.catch(() => undefined)),
			model.runUntil(task.catch(() => undefined)),
			memory.runUntil(task.catch(() => undefined))
		]);

		// recordRunCompleted must have been called with status='failed'.
		expect(completedRuns).toHaveLength(1);
		expect(completedRuns[0].status).toBe('failed');
		expect(completedRuns[0].runId).toBe(runId);
	});
});
