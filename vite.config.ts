import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	// Dev server port. Defaults to 7777; `bun run dev` overrides APP_PORT with a
	// pre-selected free port. strictPort is left false so a standalone `bun run
	// dev:web` falls back to the next free port instead of failing on a collision.
	server: {
		port: Number(process.env.APP_PORT ?? 7777)
	},
	// Cinder ships raw .svelte.ts TypeScript source files. Vite's pre-bundler can't
	// process them as plain JS, so we exclude the package from optimization and let
	// vite-plugin-svelte handle it on-demand through the full transform pipeline.
	optimizeDeps: {
		exclude: ['@lostgradient/cinder']
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter(),

			// @src/* resolves to ./src/* — usable in both Vite (web) and tsx (Worker).
			// Worker code must use @src/... instead of $lib/... since tsx can't resolve SvelteKit virtuals.
			alias: { '@src': 'src' },

			typescript: {
				config: (config) => ({
					...config,
					include: [...config.include, '../drizzle.config.ts']
				})
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					// Temporal Worker.create() webpack-bundles TypeScript on each call, which
					// can exceed Vitest 4.x defaults (5 000 ms test / 10 000 ms hook) under load
					// (the client project starts Chromium with no fork cap).  replay-histories.test.ts
					// calls Worker.create() inside beforeAll — the per-test 30_000 override there
					// does not cover the hook.  60_000 matches the ceiling already established by
					// the two explicit per-test overrides elsewhere in the suite.
					testTimeout: 60_000,
					hookTimeout: 60_000,
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [
						'src/**/*.svelte.{test,spec}.{js,ts}',
						// Workflow tests run serially in the dedicated `workflows` project below.
						'src/workflows/*.workflow.test.ts'
					]
				}
			},

			// Temporal workflow tests spin up in-memory Temporal servers and bundle workflow
			// code on every Worker.create() call.  Running them in parallel across files
			// causes CPU/memory contention that pushes the first test in each file past the
			// default 5 000 ms Vitest timeout.  `fileParallelism: false` serialises the
			// files so only one environment + bundle runs at a time, matching the behaviour
			// when each file is executed in isolation.
			{
				extends: './vite.config.ts',
				test: {
					name: 'workflows',
					environment: 'node',
					fileParallelism: false,
					// Same rationale as the `server` project: Temporal Worker.create()
					// webpack-bundles TypeScript on each call, which exceeds Vitest's
					// 5 000 ms default under load. These tests are the heaviest users of
					// Worker.create() (agent-run.workflow.test.ts does 5 sequential calls
					// per test), so the project-level floor matters most here.
					testTimeout: 60_000,
					hookTimeout: 60_000,
					include: ['src/workflows/*.workflow.test.ts']
				}
			}
		]
	}
});
