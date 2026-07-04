import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command:
			'env -u FORCE_COLOR -u NO_COLOR bun run build && env -u FORCE_COLOR -u NO_COLOR bun run preview -- --port 4319 --strictPort',
		port: 4319,
		// 4173 is Vite's global default preview port, so outside CI (where this
		// defaults to true) Playwright could silently attach to an unrelated
		// project's `vite preview` left running on that port instead of this app's
		// build. Always start our own server, and --strictPort makes a genuine
		// collision fail loud instead of vite picking a different port underneath us.
		reuseExistingServer: false
	},
	testMatch: '**/*.e2e.{ts,js}'
});
