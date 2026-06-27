import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	executeUpdate: vi.fn(),
	getHandle: vi.fn()
}));

vi.mock('$lib/server/temporal/client', () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mocks.start,
			getHandle: mocks.getHandle
		}
	})
}));

describe('turn route', () => {
	function setup(result = { accepted: true, runId: 'session-run-1' }) {
		mocks.start.mockResolvedValueOnce(undefined);
		mocks.getHandle.mockReturnValueOnce({ executeUpdate: mocks.executeUpdate });
		mocks.executeUpdate.mockResolvedValueOnce(result);
	}

	it('forwards message to submitTurnUpdate with delegateSubagents undefined when absent', async () => {
		setup();

		const response = await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/turn', {
				method: 'POST',
				body: JSON.stringify({ message: 'hello' })
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(mocks.getHandle).toHaveBeenCalledWith('agent-session:test-session');
		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ message: 'hello', delegateSubagents: undefined }]
		});
		expect(await response.json()).toMatchObject({
			accepted: true,
			runId: 'session-run-1',
			streamUrl: '/api/sessions/test-session/stream/session-run-1'
		});
	});

	it('forwards delegateSubagents: true when explicitly set in body', async () => {
		setup();

		await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/turn', {
				method: 'POST',
				body: JSON.stringify({ message: 'hello', delegateSubagents: true })
			})
		} as Parameters<typeof POST>[0]);

		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ message: 'hello', delegateSubagents: true }]
		});
	});

	it('coerces truthy non-boolean delegateSubagents to undefined', async () => {
		setup();

		await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/turn', {
				method: 'POST',
				body: JSON.stringify({ message: 'hello', delegateSubagents: 'yes' })
			})
		} as Parameters<typeof POST>[0]);

		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [{ message: 'hello', delegateSubagents: undefined }]
		});
	});

	it('returns 400 when message is missing', async () => {
		await expect(
			POST({
				params: { sessionKey: 'test-session' },
				request: new Request('http://localhost/api/sessions/test-session/turn', {
					method: 'POST',
					body: JSON.stringify({})
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when sessionKey is invalid', async () => {
		await expect(
			POST({
				params: { sessionKey: '../../evil' },
				request: new Request('http://localhost/api/sessions/%2F%2Fevil/turn', {
					method: 'POST',
					body: JSON.stringify({ message: 'hello' })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});
});
