import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTimeSkippingEnvironment } from './test-environment';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	CompactMemoryInput,
	CompactMemoryResult,
	MemoryCompactionActivities
} from '@src/lib/types';
import { TASK_QUEUE_MEMORY, TASK_QUEUE_ORCHESTRATOR } from '@src/lib/types';

describe('memoryCompactionWorkflow', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await createTimeSkippingEnvironment();
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('summarizes long sessions and updates memory references', async () => {
		const calls: string[] = [];
		const activities: MemoryCompactionActivities = {
			async loadMemoryCompactionInput(input: CompactMemoryInput) {
				calls.push(`load:${input.sessionId}:${input.fromTranscriptCursor}`);
				return {
					sessionId: input.sessionId,
					fromTranscriptCursor: input.fromTranscriptCursor,
					toTranscriptCursor: 42,
					transcript: [
						'User: I prefer pnpm for package installs.',
						'Assistant: I will use that preference in future tasks.'
					],
					existingMemoryRefs: ['memory-existing']
				};
			},
			async summarizeMemoryCompaction(input) {
				calls.push(`summarize:${input.transcript.length}`);
				return {
					summary: 'The user prefers pnpm for package installs.',
					candidates: [
						{
							layer: 'durable',
							content: 'Steve prefers pnpm for package installs.',
							tags: ['package-manager'],
							reason: 'User stated a durable package-manager preference.'
						}
					]
				};
			},
			async persistMemoryCompaction(input) {
				calls.push(`persist:${input.toTranscriptCursor}`);
				return {
					sessionId: input.sessionId,
					summaryNoteId: 'memory-summary',
					candidateIds: ['memory-pnpm'],
					memoryRefs: ['memory-existing', 'memory-summary', 'memory-pnpm'],
					transcriptCursor: input.toTranscriptCursor
				};
			}
		};

		// The workflow runs on the orchestrator queue; activities are dispatched to
		// TASK_QUEUE_MEMORY. The test uses two separate workers to exercise the real
		// queue routing — a single worker on TASK_QUEUE_ORCHESTRATOR would accept
		// the activities locally, hiding any missing taskQueue bug.
		const orchestratorWorker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		const memoryWorker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities
		});

		const workflowTask = orchestratorWorker.runUntil(async () => {
			const result: CompactMemoryResult = await env.client.workflow.execute(
				'memoryCompactionWorkflow',
				{
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					workflowId: `memory-compaction:test-${Date.now()}`,
					args: [
						{
							sessionId: 'session-compaction',
							fromTranscriptCursor: 5,
							reason: 'threshold'
						} satisfies CompactMemoryInput
					]
				}
			);

			expect(calls).toEqual(['load:session-compaction:5', 'summarize:2', 'persist:42']);
			expect(result).toEqual({
				sessionId: 'session-compaction',
				summaryNoteId: 'memory-summary',
				candidateIds: ['memory-pnpm'],
				memoryRefs: ['memory-existing', 'memory-summary', 'memory-pnpm'],
				transcriptCursor: 42
			});
		});

		// Run the memory worker in parallel — it handles activities dispatched to TASK_QUEUE_MEMORY.
		const memoryTask = memoryWorker.runUntil(workflowTask.catch(() => undefined));
		await Promise.all([workflowTask, memoryTask]);
	});
});
