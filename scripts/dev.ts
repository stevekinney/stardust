/**
 * One-command local development orchestrator for Stardust.
 *
 * Brings the whole stack up in dependency order so a newcomer can run a single
 * command and have a working app:
 *
 *   1. Reuse an already-running Temporal dev server, or start one on a free port
 *      and wait until it is reachable.
 *   2. Apply database migrations.
 *   3. Start the SvelteKit web process and the Temporal Worker process together.
 *
 * Preferred ports are 7776 (Temporal frontend), 7778 (Temporal Web UI), and 7777
 * (app). If any is taken, the orchestrator selects the next free port and passes
 * the choice to the child processes via the environment — inherited env wins over
 * `.env`, so the chosen ports take effect even when `.env` names the defaults.
 *
 * Invoke it through `bun run dev`. Teardown owns only what it started: Ctrl-C (or
 * any child exiting) tears down the web/worker processes, and the Temporal dev
 * server too — but only if this script was the one that started it.
 */
import '../src/lib/server/load-env';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS } from '../src/lib/server/config';

const [, preferredTemporalPortRaw] = TEMPORAL_ADDRESS.split(':');
const preferredTemporalPort = Number(preferredTemporalPortRaw ?? 7776);
const preferredUiPort = Number(process.env.TEMPORAL_WEB_PORT ?? 7778);
const preferredAppPort = Number(process.env.APP_PORT ?? 7777);

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

/** Resolve true if a TCP listener can bind the port on the loopback interface. */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const tester = createServer();
		tester.once('error', () => resolve(false));
		tester.once('listening', () => tester.close(() => resolve(true)));
		tester.listen(port, '127.0.0.1');
	});
}

// Ports handed out during this run, so a fallback never reassigns one already
// chosen for another service (the preferred ranges are adjacent).
const reservedPorts = new Set<number>();

/** Find the first free port at or after `preferred`, skipping already-reserved ones. */
async function reserveFreePort(preferred: number): Promise<number> {
	for (let port = preferred; port < preferred + 100; port++) {
		if (reservedPorts.has(port)) continue;
		if (await isPortFree(port)) {
			reservedPorts.add(port);
			return port;
		}
	}
	throw new Error(`[dev] No free port found near ${preferred}.`);
}

/** Try to reach a Temporal frontend, retrying a fixed number of times. */
async function connectWithRetry(address: string, maxAttempts: number): Promise<Connection | null> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await Connection.connect({ address });
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
			'[dev] MODEL_API_KEY is not set. The app and inspector will run, but any turn\n' +
				'      that calls the model will fail. Add MODEL_API_KEY to .env (see\n' +
				'      .env.example), then restart.'
		);
	}

	// 1. Temporal — reuse if reachable at the preferred address, otherwise start a
	//    new server on free ports. We only manage what we start.
	let ownsTemporal = false;
	let temporalAddress = TEMPORAL_ADDRESS;
	let temporalUiPort = preferredUiPort;
	console.log(`[dev] Checking for a Temporal dev server at ${TEMPORAL_ADDRESS} ...`);
	const existing = await connectWithRetry(TEMPORAL_ADDRESS, 1);
	if (existing) {
		await existing.close();
		console.log('[dev] Reusing the Temporal dev server already running.');
	} else {
		const port = await reserveFreePort(preferredTemporalPort);
		temporalUiPort = await reserveFreePort(preferredUiPort);
		// The server we're about to start always binds locally, regardless of what
		// host TEMPORAL_ADDRESS named (e.g. a Temporal Cloud endpoint that turned
		// out to be unreachable) — reusing that host here would point the worker/web
		// processes at a server that isn't actually there.
		temporalAddress = `localhost:${port}`;
		mkdirSync(join(homedir(), '.stardust'), { recursive: true });
		console.log(
			`[dev] Starting Temporal dev server on ${temporalAddress} (UI ${temporalUiPort}) ...`
		);
		startProcess('temporal', 'temporal', [
			'server',
			'start-dev',
			'--db-filename',
			join(homedir(), '.stardust', 'temporal.db'),
			'--port',
			String(port),
			'--ui-port',
			String(temporalUiPort)
		]);
		ownsTemporal = true;
		const connection = await connectWithRetry(temporalAddress, 30);
		if (!connection) {
			console.error(
				`[dev] Temporal never became reachable at ${temporalAddress}.\n` +
					'      Is the `temporal` CLI installed? `brew install temporal`'
			);
			await shutdown(1);
			return;
		}
		await connection.close();
		console.log('[dev] Temporal dev server is up.');
	}

	// Propagate the actual Temporal endpoint to the worker/web children. Inherited
	// env wins over .env, so the chosen ports take effect even if .env names others.
	process.env.TEMPORAL_ADDRESS = temporalAddress;
	process.env.TEMPORAL_WEB_PORT = String(temporalUiPort);

	// 2. Migrations — bring the SQLite schema current before the worker connects.
	console.log('[dev] Applying database migrations ...');
	const migrateCode = await run('bun', ['run', 'db:migrate']);
	if (migrateCode !== 0) {
		console.error('[dev] Database migration failed.');
		await shutdown(migrateCode);
		return;
	}

	// 3. Web + Worker — pick a free app port and delegate to the `dev:app` script.
	const appPort = await reserveFreePort(preferredAppPort);
	process.env.APP_PORT = String(appPort);
	startProcess('app', 'bun', ['run', 'dev:app']);

	const appUrl = `http://localhost:${appPort}`;
	const temporalWebUrl = `http://localhost:${temporalUiPort}`;
	console.log(
		`\n[dev] Stardust is starting.\n` +
			`        App           ${appUrl}\n` +
			`        Temporal Web  ${temporalWebUrl}${ownsTemporal ? '' : '  (reused existing server)'}\n` +
			`      Press Ctrl-C to stop everything${ownsTemporal ? '' : ' (the reused Temporal server is left running)'}.\n`
	);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch((error) => {
	console.error(error);
	void shutdown(1);
});
