import '@src/lib/server/load-env';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as memoryActivities from '../activities/memory.activities.ts';
import * as modelActivities from '../activities/model.activities.ts';
import * as observabilityActivities from '../activities/observability.activities.ts';
import * as policyActivities from '../activities/policy.activities.ts';
import * as sandboxActivities from '../activities/sandbox.activities.ts';
import * as scheduleActivities from '../activities/schedule.activities.ts';
import * as toolActivities from '../activities/tool.activities.ts';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '@src/lib/server/config';
import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_MODEL,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS
} from '@src/lib/server/temporal/task-queues';

const require = createRequire(import.meta.url);

export const modelTaskQueueActivities = {
	callModel: modelActivities.callModel
};

export const toolsTaskQueueActivities = {
	evaluateToolCallPolicy: policyActivities.evaluateToolCallPolicy,
	forwardApprovalToRun: policyActivities.forwardApprovalToRun,
	listToolManifest: policyActivities.listToolManifest,
	persistToolResult: observabilityActivities.persistToolResult,
	recordApprovalRequest: policyActivities.recordApprovalRequest,
	recordApprovalResolution: policyActivities.recordApprovalResolution,
	recordRunCompleted: observabilityActivities.recordRunCompleted,
	recordRunStarted: observabilityActivities.recordRunStarted,
	recordSubagentCompleted: observabilityActivities.recordSubagentCompleted,
	recordSubagentStarted: observabilityActivities.recordSubagentStarted
};

export const sandboxTaskQueueActivities = {
	cancelSandboxSession: sandboxActivities.cancelSandboxSession,
	ensureSandboxWorkspace: sandboxActivities.ensureSandboxWorkspace,
	executeTool: toolActivities.executeTool,
	readSandboxFile: sandboxActivities.readSandboxFile,
	restoreSandbox: sandboxActivities.restoreSandbox,
	runEphemeralSandboxCommand: sandboxActivities.runEphemeralSandboxCommand,
	runSandboxCommand: sandboxActivities.runSandboxCommand,
	snapshotSandbox: sandboxActivities.snapshotSandbox,
	writeSandboxFile: sandboxActivities.writeSandboxFile
};

export const memoryTaskQueueActivities = {
	confirmMemoryCandidate: memoryActivities.confirmMemoryCandidate,
	generateEmbedding: memoryActivities.generateEmbedding,
	listMemoryNotes: memoryActivities.listMemoryNotes,
	loadMemoryCompactionInput: memoryActivities.loadMemoryCompactionInput,
	persistMemoryCompaction: memoryActivities.persistMemoryCompaction,
	readMemoryNote: memoryActivities.readMemoryNote,
	searchMemory: memoryActivities.searchMemory,
	submitScheduledTurn: scheduleActivities.submitScheduledTurn,
	summarizeMemoryCompaction: memoryActivities.summarizeMemoryCompaction,
	writeMemoryCandidate: memoryActivities.writeMemoryCandidate
};

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
		activities: modelTaskQueueActivities,
		taskQueue: TASK_QUEUE_MODEL,
		connection,
		namespace
	});
	const tools = await Worker.create({
		activities: toolsTaskQueueActivities,
		taskQueue: TASK_QUEUE_TOOLS,
		connection,
		namespace
	});
	const sandbox = await Worker.create({
		activities: sandboxTaskQueueActivities,
		taskQueue: TASK_QUEUE_SANDBOX,
		connection,
		namespace
	});
	const memory = await Worker.create({
		activities: memoryTaskQueueActivities,
		taskQueue: TASK_QUEUE_MEMORY,
		connection,
		namespace
	});

	await Promise.all([orchestrator.run(), model.run(), tools.run(), sandbox.run(), memory.run()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
