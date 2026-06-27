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

describe('steer route', () => {
	it('forwards the steering message to the session workflow', async () => {
		mocks.getHandle.mockReturnValueOnce({ executeUpdate: mocks.executeUpdate });
		mocks.executeUpdate.mockResolvedValueOnce({ accepted: true });

		const response = await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/steer', {
				method: 'POST',
				body: JSON.stringify({ message: 'focus on the budget' })
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(mocks.getHandle).toHaveBeenCalledWith('agent-session:test-session');
		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ message: 'focus on the budget' }]
		});
		expect(await response.json()).toEqual({ accepted: true });
	});

	it('returns 400 when sessionKey is invalid', async () => {
		await expect(
			POST({
				params: { sessionKey: '../../evil' },
				request: new Request('http://localhost/api/sessions/%2F%2Fevil/steer', {
					method: 'POST',
					body: JSON.stringify({ message: 'x' })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when message is empty', async () => {
		await expect(
			POST({
				params: { sessionKey: 'valid-session' },
				request: new Request('http://localhost/api/sessions/valid-session/steer', {
					method: 'POST',
					body: JSON.stringify({ message: '' })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});
});
