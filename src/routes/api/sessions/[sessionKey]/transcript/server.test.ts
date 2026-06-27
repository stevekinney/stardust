import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

// Controllable per-test fixtures for the two DB selects the route performs:
// first select resolves the session row, second resolves the event rows.
let sessionRow: unknown = null;
let eventRows: unknown[] = [];

vi.mock('$lib/server/db/client', () => {
	let callCount = 0;
	return {
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: () => Promise.resolve(callCount++ === 0 ? (sessionRow ? [sessionRow] : []) : []),
						orderBy: () => Promise.resolve(eventRows)
					})
				})
			})
		}
	};
});

describe('transcript GET route', () => {
	it('returns chronological transcript events for a known session', async () => {
		sessionRow = { id: 'sess-001', sessionKey: 'my-session' };
		eventRows = [
			{ id: 'evt-1', kind: 'user_message', payload: '{"message":"hello"}', sequence: 0 },
			{ id: 'evt-2', kind: 'assistant_message', payload: '{"text":"hi"}', sequence: 1 }
		];

		const response = await GET({
			params: { sessionKey: 'my-session' }
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.events).toHaveLength(2);
		expect(body.events[0].kind).toBe('user_message');
		expect(body.events[1].kind).toBe('assistant_message');
	});

	it('returns 400 for an invalid sessionKey', async () => {
		await expect(
			GET({ params: { sessionKey: '../../evil' } } as Parameters<typeof GET>[0])
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 404 when the session does not exist', async () => {
		sessionRow = null;
		await expect(
			GET({ params: { sessionKey: 'ghost-session' } } as Parameters<typeof GET>[0])
		).rejects.toMatchObject({ status: 404 });
	});
});
