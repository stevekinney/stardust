import { describe, expect, it, vi } from 'vitest';
import { handle } from './hooks.server';

/**
 * SEC-002 regression coverage: the origin-check hook is the only boundary
 * defense for Stardust's mutating `/api/*` endpoints (see the doc comment in
 * `hooks.server.ts`). These tests exercise the hook directly rather than
 * through a real SvelteKit server, mirroring how `+server.ts` handlers are
 * unit-tested elsewhere in this codebase (call the exported function with a
 * minimal mock of the fields it reads).
 */
function makeEvent(input: { method: string; url: string; origin?: string | null }) {
	const headers = new Headers();
	if (input.origin !== null && input.origin !== undefined) {
		headers.set('origin', input.origin);
	}
	const request = new Request(input.url, { method: input.method, headers });
	const url = new URL(input.url);
	return { request, url };
}

describe('hooks.server: same-origin enforcement for /api/*', () => {
	it('allows a same-origin POST to an /api/* route', async () => {
		const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
		const event = makeEvent({
			method: 'POST',
			url: 'http://localhost:7777/api/sessions/abc123/turn',
			origin: 'http://localhost:7777'
		});

		const response = await handle({ event, resolve } as never);

		expect(resolve).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it('rejects a cross-origin POST to an /api/* route', async () => {
		const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
		const event = makeEvent({
			method: 'POST',
			url: 'http://localhost:7777/api/approvals/apr-001/resolve',
			origin: 'https://evil.test'
		});

		const response = await handle({ event, resolve } as never);

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body.message).toMatch(/forbidden/i);
	});

	it('rejects a POST to an /api/* route with no Origin header at all', async () => {
		// Non-browser clients (curl, a CSRF PoC using a `text/plain` form that
		// strips Origin, etc.) get treated the same as a wrong origin — this
		// endpoint set has no other identity check to fall back on.
		const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
		const event = makeEvent({
			method: 'POST',
			url: 'http://localhost:7777/api/sessions/abc123/steer',
			origin: null
		});

		const response = await handle({ event, resolve } as never);

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
	});

	it('allows a cross-origin GET to an /api/* route (safe method)', async () => {
		const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
		const event = makeEvent({
			method: 'GET',
			url: 'http://localhost:7777/api/health',
			origin: 'https://evil.test'
		});

		const response = await handle({ event, resolve } as never);

		expect(resolve).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it('does not apply the origin check to non-API routes', async () => {
		const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
		const event = makeEvent({
			method: 'POST',
			url: 'http://localhost:7777/sessions/abc123',
			origin: 'https://evil.test'
		});

		const response = await handle({ event, resolve } as never);

		expect(resolve).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it('rejects cross-origin PUT/PATCH/DELETE to /api/* routes', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			const resolve = vi.fn(async () => new Response('ok', { status: 200 }));
			const event = makeEvent({
				method,
				url: 'http://localhost:7777/api/schedules/sched-001',
				origin: 'https://evil.test'
			});

			const response = await handle({ event, resolve } as never);

			expect(resolve).not.toHaveBeenCalled();
			expect(response.status).toBe(403);
		}
	});
});
