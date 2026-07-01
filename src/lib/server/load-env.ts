/**
 * Loads `.env` into `process.env` for standalone Node entrypoints — the Temporal
 * Worker (`src/worker/main.ts`) and the dev orchestrator (`scripts/dev.ts`).
 *
 * Bun auto-loads `.env`, but only into its own runtime: it does not export those
 * values to child processes it spawns. Both entrypoints run under `tsx` (Node),
 * launched as children of `bun run`, so without this they would never see `.env`
 * values such as `ANTHROPIC_API_KEY` — the worker reads that key when calling the
 * model. The web process is covered separately by Vite/SvelteKit's env loading.
 *
 * Import this module for its side effect *before* importing anything that reads
 * `process.env` at module-load time (notably `./config`).
 */
import { loadEnvFile } from 'node:process';

try {
	loadEnvFile();
} catch {
	// No `.env` file present — fall back to the ambient environment.
}
