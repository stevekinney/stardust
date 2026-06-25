// Fixture: a valid workflow that imports only from @temporalio/workflow.
// Must produce zero temporal/* lint violations.

import { proxyActivities, sleep } from '@temporalio/workflow';

type CleanActivities = {
	doSomething(): Promise<void>;
};

const { doSomething } = proxyActivities<CleanActivities>({
	startToCloseTimeout: '10 minutes',
	retry: { maximumAttempts: 3 }
});

export async function cleanWorkflow(): Promise<void> {
	await doSomething();
	await sleep('1 second');
}
