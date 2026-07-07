import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { getToolManifest } from '$lib/server/tools/registry';
import { TASK_QUEUE_TOOLS } from '$lib/server/temporal/task-queues';

vi.mock('$lib/server/tools/registry', () => ({
	getToolManifest: vi.fn()
}));

describe('GET /api/tools', () => {
	it('returns the configured tool manifest as name/description/risk', async () => {
		vi.mocked(getToolManifest).mockReturnValueOnce([
			{
				name: 'shell.exec',
				description: 'Runs a shell command',
				inputSchema: {},
				metadata: {
					risk: 'high',
					requiresApproval: true,
					taskQueue: TASK_QUEUE_TOOLS,
					timeoutMs: 30_000,
					retry: { maximumAttempts: 1 },
					idempotencyBehavior: 'unsafe'
				}
			}
		]);

		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tools: [{ name: 'shell.exec', description: 'Runs a shell command', risk: 'high' }]
		});
	});

	it('returns an empty list when no tools are configured', async () => {
		vi.mocked(getToolManifest).mockReturnValueOnce([]);

		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(await response.json()).toEqual({ tools: [] });
	});
});
