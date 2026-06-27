import type {
	CompactMemoryInput,
	CompactMemoryResult,
	MemoryCompactionActivities
} from '@src/lib/types';
import { proxyActivities } from '@temporalio/workflow';

// Inline string to avoid a value import from @src/lib/types, which webpack cannot
// resolve when bundling the workflow sandbox. The constant matches TASK_QUEUE_MEMORY
// defined in src/lib/types/index.ts and src/lib/server/temporal/task-queues.ts.
const TASK_QUEUE_MEMORY = 'memory';

const activities = proxyActivities<MemoryCompactionActivities>({
	taskQueue: TASK_QUEUE_MEMORY,
	startToCloseTimeout: '1 minute',
	retry: {
		maximumAttempts: 3
	}
});

export async function memoryCompactionWorkflow(
	input: CompactMemoryInput
): Promise<CompactMemoryResult> {
	const loadedInput = await activities.loadMemoryCompactionInput(input);
	const summary = await activities.summarizeMemoryCompaction(loadedInput);
	return activities.persistMemoryCompaction({
		...loadedInput,
		...summary
	});
}
