import type { Handle } from '@sveltejs/kit';

/**
 * Same-origin enforcement for state-changing API requests.
 *
 * SEC-002: SvelteKit's own built-in CSRF protection (`csrf.checkOrigin`) is
 * skipped entirely in dev mode (`!DEV` gate in
 * `@sveltejs/kit/src/runtime/server/respond.js`), and even in production it
 * only inspects requests whose `content-type` is one of the three HTML-form
 * content types — it never looks at `application/json` bodies. Stardust's
 * mutating `/api/*` endpoints (approval resolution, turn/steer/interrupt,
 * schedule mutations, memory-candidate actions) accept JSON bodies and have
 * no auth layer of their own (this is a local, single-user dev tool), so a
 * malicious page the developer merely has open in another tab — while
 * `bun run dev` is running — could otherwise drive a background
 * `fetch(..., { method: 'POST', headers: { 'content-type': 'text/plain' }, body })`
 * against `localhost` and have it silently accepted, in dev *and* prod,
 * regardless of body content-type.
 *
 * This hook is the single boundary check: any non-GET/HEAD request to
 * `/api/*` must carry an `Origin` header that matches the request's own
 * origin. Modern browsers attach `Origin` on every state-changing request
 * (same-origin or not), so legitimate same-origin fetches from Stardust's
 * own client code are unaffected; only cross-origin browser requests are
 * rejected. Non-browser clients (curl, `gh`, server-to-server calls) that
 * omit `Origin` are also rejected — this endpoint set has no other identity
 * check, so "no origin" is treated the same as "wrong origin."
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
	const { request, url } = event;

	if (url.pathname.startsWith('/api/') && !SAFE_METHODS.has(request.method)) {
		const origin = request.headers.get('origin');
		if (origin !== url.origin) {
			return new Response(
				JSON.stringify({ message: 'Cross-origin requests to the Stardust API are forbidden.' }),
				{ status: 403, headers: { 'content-type': 'application/json' } }
			);
		}
	}

	return resolve(event);
};
