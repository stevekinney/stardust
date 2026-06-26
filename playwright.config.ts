import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command:
			'env -u FORCE_COLOR -u NO_COLOR bun run build && env -u FORCE_COLOR -u NO_COLOR bun run preview',
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
