import { describe, expect, it, vi } from 'vitest';
import { GET, POST } from './+server';
import { SESSION_KEY_RE } from '$lib/server/session-key';

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({
			from: () => ({
				orderBy: () => Promise.resolve([])
			})
		})
	}
}));

describe('GET /api/sessions', () => {
	it('returns an empty sessions array when no sessions exist', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ sessions: [] });
	});
});

describe('POST /api/sessions', () => {
	it('returns a server-minted session key with status 201', async () => {
		const response = await POST({} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(201);
		const body = await response.json();
		expect(typeof body.sessionKey).toBe('string');
	});

	it('minted key satisfies the canonical session key format', async () => {
		const response = await POST({} as Parameters<typeof POST>[0]);
		const { sessionKey } = await response.json();
		expect(SESSION_KEY_RE.test(sessionKey)).toBe(true);
	});

	it('returns a different key on each call', async () => {
		const [responseA, responseB] = await Promise.all([
			POST({} as Parameters<typeof POST>[0]),
			POST({} as Parameters<typeof POST>[0])
		]);
		const a = await responseA.json();
		const b = await responseB.json();
		expect(a.sessionKey).not.toBe(b.sessionKey);
	});
});
