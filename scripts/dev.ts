/**
 * One-command local development orchestrator for Stardust.
 *
 * Brings the whole stack up in dependency order so a newcomer can run a single
 * command and have a working app:
 *
 *   1. Reuse an already-running Temporal dev server, or start one and wait until
 *      it is reachable.
 *   2. Apply database migrations.
 *   3. Start the SvelteKit web process and the Temporal Worker process together.
 *
 * Invoke it through `bun run dev` so Bun loads `.env` into the environment before
 * this script (and every child it spawns via `bun run`) reads `process.env`.
 *
 * Teardown is clean and owns only what it started: Ctrl-C (or any child exiting)
 * tears down the web/worker processes, and the Temporal dev server too — but only
 * if this script was the one that started it.
 */
import '../src/lib/server/load-env';
import { spawn, type ChildProcess } from 'node:child_process';
import { Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS } from '../src/lib/server/config';

const WEB_URL = 'http://localhost:5173';
const TEMPORAL_WEB_PORT = process.env.TEMPORAL_WEB_PORT ?? '8233';
const TEMPORAL_WEB_URL = `http://localhost:${TEMPORAL_WEB_PORT}`;

type ManagedProcess = { name: string; child: ChildProcess };

const managedProcesses: ManagedProcess[] = [];
let shuttingDown = false;

/** Spawn a long-running child in its own process group, prefixing its output. */
function startProcess(name: string, command: string, args: string[]): ManagedProcess {
	const child = spawn(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	child.stdout?.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
	child.stderr?.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
	const managed = { name, child };
	managedProcesses.push(managed);
	child.on('exit', (code) => {
		if (!shuttingDown) {
			console.error(`\n[dev] "${name}" exited (code ${code ?? 'null'}). Shutting everything down.`);
			void shutdown(code ?? 1);
		}
	});
	return managed;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Try to reach the Temporal frontend, retrying a fixed number of times. */
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

/** Run a command to completion, inheriting stdio. Resolves with the exit code. */
function run(command: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.on('exit', (code) => resolve(code ?? 1));
	});
}

async function stopProcess({ child }: ManagedProcess): Promise<void> {
	if (child.exitCode !== null || child.pid === undefined) return;
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-child.pid!, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	};
	signalGroup('SIGTERM');
	await sleep(500);
	if (child.exitCode === null) signalGroup('SIGKILL');
}

async function shutdown(code: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await Promise.all(managedProcesses.map(stopProcess));
	process.exit(code);
}

async function main() {
	if (!process.env.MODEL_API_KEY) {
		console.warn(
			'[dev] MODEL_API_KEY is not set. The app and inspector will run, but any turn that\n' +
				'      calls the model will fail. Add MODEL_API_KEY to .env (see .env.example), then\n' +
				'      restart. Bun loads .env automatically for `bun run` commands.'
		);
	}

	// 1. Temporal — reuse if reachable, otherwise start it and wait. We only manage
	//    the lifecycle of a server we started ourselves.
	let ownsTemporal = false;
	console.log(`[dev] Checking for a Temporal dev server at ${TEMPORAL_ADDRESS} ...`);
	let connection = await connectWithRetry(1);
	if (connection) {
		console.log('[dev] Reusing the Temporal dev server already running.');
	} else {
		console.log('[dev] None found. Starting `temporal server start-dev` ...');
		startProcess('temporal', 'bun', ['run', 'temporal:dev']);
		ownsTemporal = true;
		connection = await connectWithRetry(30);
		if (!connection) {
			console.error(
				`[dev] Temporal never became reachable at ${TEMPORAL_ADDRESS}.\n` +
					'      Is the `temporal` CLI installed? `brew install temporal`'
			);
			await shutdown(1);
			return;
		}
		console.log('[dev] Temporal dev server is up.');
	}
	await connection.close();

	// 2. Migrations — bring the SQLite schema current before the worker connects.
	console.log('[dev] Applying database migrations ...');
	const migrateCode = await run('bun', ['run', 'db:migrate']);
	if (migrateCode !== 0) {
		console.error('[dev] Database migration failed.');
		await shutdown(migrateCode);
		return;
	}

	// 3. Web + Worker — delegated to the `dev:app` concurrently script.
	startProcess('app', 'bun', ['run', 'dev:app']);

	console.log(
		`\n[dev] Stardust is starting.\n` +
			`        App           ${WEB_URL}\n` +
			`        Temporal Web  ${TEMPORAL_WEB_URL}${ownsTemporal ? '' : '  (reused existing server)'}\n` +
			`      Press Ctrl-C to stop everything${ownsTemporal ? '' : ' (the reused Temporal server is left running)'}.\n`
	);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch((error) => {
	console.error(error);
	void shutdown(1);
});
