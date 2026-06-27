import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const mocks = vi.hoisted(() => ({
	executeUpdate: vi.fn(),
	getHandle: vi.fn()
}));

vi.mock('$lib/server/temporal/client', () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			getHandle: mocks.getHandle
		}
	})
}));

describe('interrupt route', () => {
	it('sends an interruptRun update to the session workflow', async () => {
		mocks.getHandle.mockReturnValueOnce({ executeUpdate: mocks.executeUpdate });
		mocks.executeUpdate.mockResolvedValueOnce({ interrupted: true });

		const response = await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/interrupt', {
				method: 'POST',
				body: JSON.stringify({})
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(mocks.getHandle).toHaveBeenCalledWith('agent-session:test-session');
		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ replacement: undefined }]
		});
		expect(await response.json()).toEqual({ interrupted: true });
	});

	it('forwards an optional replacement message', async () => {
		mocks.getHandle.mockReturnValueOnce({ executeUpdate: mocks.executeUpdate });
		mocks.executeUpdate.mockResolvedValueOnce({
			interrupted: true,
			replacementRunId: 'run-002'
		});

		const response = await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/interrupt', {
				method: 'POST',
				body: JSON.stringify({ replacement: 'actually, tell me about Mars instead' })
			})
		} as Parameters<typeof POST>[0]);

		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ replacement: 'actually, tell me about Mars instead' }]
		});
		expect(await response.json()).toEqual({
			interrupted: true,
			replacementRunId: 'run-002'
		});
	});

	it('returns 400 when sessionKey is invalid', async () => {
		await expect(
			POST({
				params: { sessionKey: '../../evil' },
				request: new Request('http://localhost/api/sessions/%2F%2Fevil/interrupt', {
					method: 'POST',
					body: JSON.stringify({})
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});
});
