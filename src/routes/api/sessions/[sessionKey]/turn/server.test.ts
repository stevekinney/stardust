import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	executeUpdate: vi.fn(),
	getHandle: vi.fn(),
	writeFile: vi.fn()
}));

vi.mock('$lib/server/temporal/client', () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mocks.start,
			getHandle: mocks.getHandle
		}
	})
}));

vi.mock('$lib/server/sandbox', () => ({
	getSandboxProvider: () => ({ writeFile: mocks.writeFile })
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

	it('writes each attachment into the sandbox workspace and appends a reference note to the message', async () => {
		setup();

		await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/turn', {
				method: 'POST',
				body: JSON.stringify({
					message: 'Look at this',
					attachments: [{ name: 'bug.png', mimeType: 'image/png', kind: 'image', content: 'QUJD' }]
				})
			})
		} as Parameters<typeof POST>[0]);

		expect(mocks.writeFile).toHaveBeenCalledWith({
			sessionKey: 'test-session',
			path: 'attachments/bug.png',
			contents: 'QUJD',
			encoding: 'base64'
		});
		const call = mocks.executeUpdate.mock.calls.at(-1)?.[1] as { args: [{ message: string }] };
		expect(call.args[0].message).toContain('Look at this');
		expect(call.args[0].message).toContain('attachments/bug.png');
	});

	it('accepts an attachment-only submission with no message text', async () => {
		setup();

		const response = await POST({
			params: { sessionKey: 'test-session' },
			request: new Request('http://localhost/api/sessions/test-session/turn', {
				method: 'POST',
				body: JSON.stringify({
					attachments: [
						{ name: 'notes.txt', mimeType: 'text/plain', kind: 'document', content: 'aGk=' }
					]
				})
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(mocks.writeFile).toHaveBeenCalledWith({
			sessionKey: 'test-session',
			path: 'attachments/notes.txt',
			contents: 'aGk=',
			encoding: 'base64'
		});
	});

	it('returns 400 when more than 5 attachments are submitted', async () => {
		const attachments = Array.from({ length: 6 }, (_, index) => ({
			name: `file-${index}.txt`,
			mimeType: 'text/plain',
			kind: 'document',
			content: 'aGk='
		}));

		await expect(
			POST({
				params: { sessionKey: 'test-session' },
				request: new Request('http://localhost/api/sessions/test-session/turn', {
					method: 'POST',
					body: JSON.stringify({ message: 'hello', attachments })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when an attachment decodes to more than 10MB', async () => {
		const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 'a').toString('base64');

		await expect(
			POST({
				params: { sessionKey: 'test-session' },
				request: new Request('http://localhost/api/sessions/test-session/turn', {
					method: 'POST',
					body: JSON.stringify({
						message: 'hello',
						attachments: [
							{
								name: 'big.bin',
								mimeType: 'application/octet-stream',
								kind: 'document',
								content: oversized
							}
						]
					})
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when an attachment is missing required fields', async () => {
		await expect(
			POST({
				params: { sessionKey: 'test-session' },
				request: new Request('http://localhost/api/sessions/test-session/turn', {
					method: 'POST',
					body: JSON.stringify({ message: 'hello', attachments: [{ name: 'x.txt' }] })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 503 with the underlying reason when Temporal is unreachable', async () => {
		mocks.start.mockRejectedValueOnce(new Error('Temporal namespace "depict.bnfgy" not found'));

		await expect(
			POST({
				params: { sessionKey: 'test-session' },
				request: new Request('http://localhost/api/sessions/test-session/turn', {
					method: 'POST',
					body: JSON.stringify({ message: 'hello' })
				})
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({
			status: 503,
			body: { message: 'Temporal namespace "depict.bnfgy" not found' }
		});
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
