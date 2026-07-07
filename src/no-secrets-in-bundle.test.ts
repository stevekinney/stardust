import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEC-003: no-secrets-in-bundle check.
 *
 * Builds the app for real (adapter-node output under `.svelte-kit/output`)
 * and scans the client bundle — the part of the build that is served
 * verbatim to any browser that loads the app — for known secret patterns:
 * the literal value of `.env`'s secrets, `sk-ant-` (Anthropic key prefix),
 * Temporal Cloud API key shapes, and the bare env-var names paired with a
 * suspicious `=`-assigned value (which would indicate build-time inlining
 * rather than a safe runtime `process.env` read).
 *
 * Server output (`.svelte-kit/output/server`) legitimately references env
 * var *names* (`process.env.TEMPORAL_API_KEY`) since that code runs on the
 * server and is never shipped to a browser — this check only asserts on the
 * client bundle, which is the actual exposure surface.
 */

const root = path.resolve(import.meta.dirname, '..');
const clientOutputDir = path.join(root, '.svelte-kit/output/client');

function listFilesRecursively(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFilesRecursively(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

/** Patterns that must never appear in code shipped to the browser. */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: 'Anthropic API key prefix', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
	{ name: 'Temporal Cloud API key prefix', pattern: /tmprl_[A-Za-z0-9_-]{10,}/ },
	// A build-time-inlined secret would show up as the env var name directly
	// assigned a quoted value in generated JS, e.g. `ANTHROPIC_API_KEY="sk-..."`
	// or `="stardust-local-dev-secret"`. A *runtime* read (`process.env.X`,
	// which is what the server output legitimately contains) never matches
	// this shape once bundled for the browser, because `process.env` isn't
	// available in client code in the first place.
	{ name: 'inlined ARTIFACT_TOKEN_SECRET default value', pattern: /stardust-local-dev-secret/ }
];

describe('no secrets leak into the client bundle', () => {
	// `bun run build` normally finishes in single-digit seconds (see
	// scripts/build.ts / PROGRESS.md's discovery-pass timing), but this test
	// shells out to a real subprocess build rather than mocking it, so its
	// wall-clock time scales with whatever else is competing for CPU on the
	// machine (mirrors the same root cause behind vite.config.ts's 60_000ms
	// testTimeout/hookTimeout overrides for the Temporal-heavy suites). 180s
	// is a generous ceiling for a bounded, non-hanging operation — a genuine
	// build failure or hang would still fail this test, just later.
	it('bun run build produces a client bundle with no known secret patterns', () => {
		execSync('bun run build', { cwd: root, stdio: 'pipe' });

		expect(statSync(clientOutputDir).isDirectory()).toBe(true);

		const files = listFilesRecursively(clientOutputDir).filter((file) =>
			/\.(js|mjs|css|html|json|map)$/.test(file)
		);
		expect(files.length).toBeGreaterThan(0);

		const offenders: Array<{ file: string; pattern: string }> = [];
		for (const file of files) {
			const contents = readFileSync(file, 'utf-8');
			for (const { name, pattern } of SECRET_PATTERNS) {
				if (pattern.test(contents)) {
					offenders.push({ file: path.relative(root, file), pattern: name });
				}
			}
			// Env var names are fine to reference (e.g. in a diagnostic string),
			// but they must never be immediately followed by an `=` and a quoted
			// value — that shape only occurs if a secret got inlined at build
			// time instead of read from `process.env` at runtime.
			for (const varName of ['ANTHROPIC_API_KEY', 'TEMPORAL_API_KEY', 'ARTIFACT_TOKEN_SECRET']) {
				const inlinedAssignment = new RegExp(`${varName}\\s*[:=]\\s*["'][^"']{4,}["']`);
				if (inlinedAssignment.test(contents)) {
					offenders.push({ file: path.relative(root, file), pattern: `inlined ${varName}` });
				}
			}
		}

		expect(offenders).toEqual([]);
	}, 180_000);

	it('the health endpoint response shape does not include raw config/env objects', async () => {
		const source = readFileSync(path.join(root, 'src/routes/api/health/+server.ts'), 'utf-8');
		// Guard against a future regression where someone spreads the whole
		// config module (or process.env) into the JSON response instead of
		// building an explicit HealthSnapshot.
		expect(source).not.toMatch(/\.\.\.\s*(process\.env|config)\b/);
		expect(source).not.toContain('TEMPORAL_API_KEY');
		expect(source).not.toContain('ARTIFACT_TOKEN_SECRET');
	});
});
