import type {
	CompactMemoryInput,
	CompactMemoryResult,
	MemoryCompactionActivities
} from '@src/lib/types';
import { proxyActivities } from '@temporalio/workflow';

const activities = proxyActivities<MemoryCompactionActivities>({
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
