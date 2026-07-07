import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsStore } from './sessions.svelte';
import type { SessionRow } from '$lib/types';

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: 'sess-1',
		sessionKey: 'demo-seed-mr2hx0la',
		status: 'active',
		workflowId: 'agent-session:demo-seed-mr2hx0la',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		name: 'Original name',
		...overrides
	};
}

describe('SessionsStore.rename', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('PATCHes the session and updates the cached row in place', async () => {
		const store = new SessionsStore();
		store.sessions = [makeSession()];
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ sessionKey: 'demo-seed-mr2hx0la', name: 'Renamed' }), {
				status: 200
			})
		);

		await store.rename('demo-seed-mr2hx0la', 'Renamed');

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sessions/demo-seed-mr2hx0la',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ name: 'Renamed' })
			})
		);
		expect(store.sessions[0].name).toBe('Renamed');
	});

	it('leaves other cached rows untouched', async () => {
		const store = new SessionsStore();
		store.sessions = [makeSession(), makeSession({ id: 'sess-2', sessionKey: 'other-session' })];
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ sessionKey: 'demo-seed-mr2hx0la', name: 'Renamed' }), {
				status: 200
			})
		);

		await store.rename('demo-seed-mr2hx0la', 'Renamed');

		expect(store.sessions[1].name).toBe('Original name');
	});

	it('throws and leaves the cache unchanged when the request fails', async () => {
		const store = new SessionsStore();
		store.sessions = [makeSession()];
		fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

		await expect(store.rename('demo-seed-mr2hx0la', 'Renamed')).rejects.toThrow();
		expect(store.sessions[0].name).toBe('Original name');
	});
});
