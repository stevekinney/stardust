import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
	ApprovalCardState,
	ApprovalResolution,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	ToolCallInput,
	ToolExecutionInput,
	ToolExecutionResult,
	ToolManifestEntry,
	ToolPolicyDecision
} from '@src/lib/types';
import { TASK_QUEUE_ORCHESTRATOR, TASK_QUEUE_SANDBOX, TASK_QUEUE_TOOLS } from '@src/lib/types';
import { getAgentRunStateQuery, resolveApprovalUpdate } from './approval-contracts';

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

const riskyToolCall: ToolCallInput = {
	id: 'tool-call-001',
	name: 'workspace.writeFile',
	arguments: { path: 'notes.txt', content: 'draft' }
};

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

function terminalStateForAction(
	action: RecordApprovalResolutionInput['action']
): ApprovalResolution['terminalState'] {
	if (action === 'approve' || action === 'approve_with_edits') return 'approved';
	if (action === 'deny') return 'denied';
	if (action === 'remember') return 'remembered';
	if (action === 'cancel') return 'cancelled';
	return 'expired';
}

const testActivities = {
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
	}
};

describe('agentRunWorkflow approvals', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	beforeEach(() => {
		activityState.requests = [];
		activityState.resolutions = [];
		activityState.executions = [];
		activityState.startedRuns = [];
		activityState.completedRuns = [];
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

		const task = orchestrator.runUntil(callback);
		const toolsTask = tools.runUntil(task.catch(() => undefined));
		const sandboxTask = sandbox.runUntil(task.catch(() => undefined));
		const [result] = await Promise.all([task, toolsTask, sandboxTask]);
		return result;
	}

	it('parks a risky tool call in waiting_approval', async () => {
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
						toolCalls: [riskyToolCall],
						approvalTtlMs: 60_000
					}
				]
			});

			let state = await handle.query(getAgentRunStateQuery);
			for (let i = 0; i < 10 && state.status !== 'waiting_approval'; i++) {
				await env.sleep(100);
				state = await handle.query(getAgentRunStateQuery);
			}

			expect(state.status).toBe('waiting_approval');
			expect(state.pendingApproval?.approvalId).toBe(`${runId}:tool-call-001:approval`);
			expect(activityState.requests).toHaveLength(1);

			await handle.executeUpdate(resolveApprovalUpdate, {
				args: [
					{
						approvalId: `${runId}:tool-call-001:approval`,
						action: 'cancel',
						reason: 'stop'
					}
				]
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
						toolCalls: [riskyToolCall],
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
				args: [
					{
						approvalId,
						action: 'approve_with_edits',
						editedArguments,
						remember: true
					}
				]
			});
			const result = await handle.result();

			expect(resolution.proposedArguments).toEqual(riskyToolCall.arguments);
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
						toolCalls: [riskyToolCall],
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
						toolCalls: [riskyToolCall],
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
