import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	CompactMemoryInput,
	CompactMemoryResult,
	MemoryCompactionActivities
} from '@src/lib/types';
import { TASK_QUEUE_ORCHESTRATOR } from '@src/lib/types';

describe('memoryCompactionWorkflow', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
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

		const worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
			activities
		});

		await worker.runUntil(async () => {
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
	});
});
