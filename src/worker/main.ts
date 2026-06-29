import '@src/lib/server/load-env';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createRequire } from 'node:module';
import * as activities from '../activities/index.ts';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '@src/lib/server/config';
import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_MODEL,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS
} from '@src/lib/server/temporal/task-queues';

const require = createRequire(import.meta.url);

async function main() {
	const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
	const namespace = TEMPORAL_NAMESPACE;

	const orchestrator = await Worker.create({
		workflowsPath: require.resolve('../workflows/index.ts'),
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		connection,
		namespace
	});

	const model = await Worker.create({
		activities,
		taskQueue: TASK_QUEUE_MODEL,
		connection,
		namespace
	});
	const tools = await Worker.create({
		activities,
		taskQueue: TASK_QUEUE_TOOLS,
		connection,
		namespace
	});
	const sandbox = await Worker.create({
		activities,
		taskQueue: TASK_QUEUE_SANDBOX,
		connection,
		namespace
	});
	const memory = await Worker.create({
		activities,
		taskQueue: TASK_QUEUE_MEMORY,
		connection,
		namespace
	});

	await Promise.all([orchestrator.run(), model.run(), tools.run(), sandbox.run(), memory.run()]);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
