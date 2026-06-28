import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { agentRunWorkflow } from '../../src/workflows/agent-run.workflow';
import {
	getAgentRunStateQuery,
	resolveApprovalUpdate
} from '../../src/workflows/approval-contracts';
import { TASK_QUEUE_ORCHESTRATOR } from '../../src/lib/types';
import * as schema from '../../src/lib/server/db/schema';
import { readRunInspectorProjection } from '../../src/lib/server/observability/projection';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TEMPORAL_WEB_PORT = process.env.TEMPORAL_WEB_PORT ?? '8233';

type ManagedProcess = {
	name: string;
	child: ChildProcess;
};

function startProcess(
	name: string,
	command: string,
	args: string[],
	options: { environment?: NodeJS.ProcessEnv } = {}
): ManagedProcess {
	const child = spawn(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...options.environment },
		detached: true
	});
	child.stdout?.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
	child.stderr?.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
	return { name, child };
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectWithRetry(maxAttempts: number): Promise<Connection | null> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await Connection.connect({ address: TEMPORAL_ADDRESS });
		} catch {
			await sleep(1_000);
		}
	}
	return null;
}

async function stopProcess(processHandle: ManagedProcess): Promise<void> {
	if (processHandle.child.exitCode !== null) return;
	if (processHandle.child.pid) {
		try {
			process.kill(-processHandle.child.pid, 'SIGTERM');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	} else {
		processHandle.child.kill('SIGTERM');
	}
	await sleep(500);
	if (processHandle.child.exitCode !== null) return;
	if (processHandle.child.pid) {
		try {
			process.kill(-processHandle.child.pid, 'SIGKILL');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	} else {
		processHandle.child.kill('SIGKILL');
	}
}

async function main() {
	const scratchDirectory = await mkdtemp(join(tmpdir(), 'stardust-chaos-'));
	const databasePath = join(scratchDirectory, 'stardust.db');
	const workspacePath = join(scratchDirectory, 'workspace');
	const runId = `chaos-${Date.now()}`;
	const sessionId = `chaos-session-${Date.now()}`;
	const managedProcesses: ManagedProcess[] = [];
	let connection: Connection | null = null;

	try {
		await mkdir(workspacePath, { recursive: true });
		const databaseUrl = `file:${databasePath}`;
		const migrationDatabase = new Database(databasePath);
		migrationDatabase.pragma('journal_mode = WAL');
		const migrationClient = drizzle(migrationDatabase, { schema });
		migrate(migrationClient, { migrationsFolder: './drizzle' });
		migrationDatabase.close();

		connection = await connectWithRetry(2);
		if (!connection) {
			const temporal = startProcess('temporal', 'temporal', [
				'server',
				'start-dev',
				'--db-filename',
				join(scratchDirectory, 'temporal.db'),
				'--ui-port',
				TEMPORAL_WEB_PORT
			]);
			managedProcesses.push(temporal);
			connection = await connectWithRetry(20);
		}
		if (!connection) throw new Error(`Temporal is not reachable at ${TEMPORAL_ADDRESS}`);

		const workerEnvironment = { DATABASE_URL: databaseUrl };
		const firstWorker = startProcess('worker-1', 'bun', ['run', 'dev:worker'], {
			environment: workerEnvironment
		});
		const secondWorker = startProcess('worker-2', 'bun', ['run', 'dev:worker'], {
			environment: workerEnvironment
		});
		managedProcesses.push(firstWorker, secondWorker);

		const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
		const handle = await client.workflow.start(agentRunWorkflow, {
			workflowId: `agent-run:${runId}`,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
			args: [
				{
					sessionKey: sessionId,
					runId,
					message: 'Chaos recovery run',
					workspacePath,
					approvalTtlMs: 60_000
				}
			]
		});

		// Poll until the workflow parks at a tool-approval gate, capturing the
		// live approvalId from the state snapshot *before* killing the worker so
		// we don't depend on the killed process to serve a re-query.
		let liveApprovalId: string | undefined;
		for (let attempt = 1; attempt <= 20; attempt++) {
			const state = await handle.query(getAgentRunStateQuery);
			if (state.status === 'waiting_approval') {
				if (!state.pendingApproval) {
					throw new Error('waiting_approval state has no pendingApproval');
				}
				liveApprovalId = state.pendingApproval.approvalId;
				break;
			}
			await sleep(500);
			if (attempt === 20) throw new Error('Run did not enter waiting_approval before chaos kill');
		}
		if (!liveApprovalId) {
			throw new Error('Internal error: approval loop exited without capturing approvalId');
		}

		if (firstWorker.child.pid) {
			process.kill(-firstWorker.child.pid, 'SIGKILL');
		} else {
			firstWorker.child.kill('SIGKILL');
		}
		await sleep(1_000);

		await handle.executeUpdate(resolveApprovalUpdate, {
			args: [{ approvalId: liveApprovalId, action: 'approve', reason: 'Chaos demo approval' }]
		});
		const result = await handle.result();
		if (result.status !== 'complete') {
			throw new Error(`Chaos run did not complete: ${JSON.stringify(result)}`);
		}

		const verificationDatabase = new Database(databasePath);
		verificationDatabase.pragma('journal_mode = WAL');
		const verificationClient = drizzle(verificationDatabase, { schema });
		const projection = await readRunInspectorProjection(verificationClient, runId);
		verificationDatabase.close();

		if (!projection) throw new Error(`No inspector projection was persisted for ${runId}`);
		if (!projection.temporalWebUrl.includes('localhost:8233')) {
			throw new Error(
				`Temporal Web link did not target localhost:8233: ${projection.temporalWebUrl}`
			);
		}
		if (projection.idempotencyEntries.length !== 1) {
			throw new Error(
				`Expected one idempotency entry, found ${projection.idempotencyEntries.length}`
			);
		}
		if (projection.run.status !== 'complete') {
			throw new Error(`Expected persisted run status complete, found ${projection.run.status}`);
		}

		console.log(`STARDUST_T11_CHAOS_OK ${runId}`);
	} finally {
		await Promise.all(managedProcesses.map(stopProcess));
		await connection?.close();
		await rm(scratchDirectory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
