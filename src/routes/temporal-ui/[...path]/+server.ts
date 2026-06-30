import type { RequestHandler } from './$types';
import { TEMPORAL_WEB_URL } from '$lib/server/config';

const TEMPORAL_UI_PROXY_PREFIX = '/temporal-ui';

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
	'content-encoding',
	'content-length',
	'content-security-policy',
	'content-security-policy-report-only',
	'x-frame-options'
]);

const REWRITABLE_CONTENT_TYPE_PREFIXES = [
	'text/html',
	'text/css',
	'text/javascript',
	'application/javascript',
	'application/json'
];

const ABSOLUTE_TEMPORAL_UI_PATH_PREFIXES = ['_app/'];

function buildTemporalUiUrl(path: string | undefined, search: string): URL {
	const upstreamPath = path ? `${path}${search}` : search;
	return new URL(upstreamPath, `${TEMPORAL_WEB_URL}/`);
}

function copyRequestHeaders(request: Request): Headers {
	const headers = new Headers(request.headers);
	for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
	headers.delete('accept-encoding');
	headers.delete('host');
	return headers;
}

function copyResponseHeaders(response: Response): Headers {
	const headers = new Headers();

	response.headers.forEach((value, key) => {
		const normalizedKey = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(normalizedKey)) return;
		if (BLOCKED_RESPONSE_HEADERS.has(normalizedKey)) return;
		if (normalizedKey === 'set-cookie') return;
		headers.append(key, value);
	});

	for (const cookie of getSetCookieHeaders(response.headers)) {
		headers.append('set-cookie', rewriteCookiePath(cookie));
	}

	return headers;
}

function getSetCookieHeaders(headers: Headers): string[] {
	const headersWithCookies = headers as Headers & { getSetCookie?: () => string[] };
	if (headersWithCookies.getSetCookie) return headersWithCookies.getSetCookie();

	const cookie = headers.get('set-cookie');
	return cookie ? [cookie] : [];
}

function rewriteCookiePath(cookie: string): string {
	if (/;\s*path=/i.test(cookie)) {
		return cookie.replace(/;\s*path=\/(?=;|$)/i, `; Path=${TEMPORAL_UI_PROXY_PREFIX}`);
	}

	return `${cookie}; Path=${TEMPORAL_UI_PROXY_PREFIX}`;
}

function shouldRewriteResponse(contentType: string | null): boolean {
	if (!contentType) return false;
	const normalizedContentType = contentType.toLowerCase();
	return REWRITABLE_CONTENT_TYPE_PREFIXES.some((prefix) =>
		normalizedContentType.startsWith(prefix)
	);
}

function rewriteTemporalUiText(value: string): string {
	let rewritten = value.replace(
		/<meta\s+http-equiv=["']content-security-policy["'][^>]*>\s*/gi,
		''
	);

	rewritten = rewritten.replace(/\bbase:\s*""/g, `base: "${TEMPORAL_UI_PROXY_PREFIX}"`);

	for (const pathPrefix of ABSOLUTE_TEMPORAL_UI_PATH_PREFIXES) {
		for (const quote of ['"', "'", '`']) {
			rewritten = rewritten.replaceAll(
				`${quote}/${pathPrefix}`,
				`${quote}${TEMPORAL_UI_PROXY_PREFIX}/${pathPrefix}`
			);
		}
	}

	return rewritten;
}

async function proxyTemporalUi({ params, request, url }: Parameters<RequestHandler>[0]) {
	const temporalUiUrl = buildTemporalUiUrl(params.path, url.search);
	const requestInit: RequestInit = {
		method: request.method,
		headers: copyRequestHeaders(request)
	};

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		requestInit.body = await request.arrayBuffer();
	}

	let upstreamResponse: Response;
	try {
		upstreamResponse = await fetch(temporalUiUrl, requestInit);
	} catch {
		return new Response(`Temporal UI is not reachable at ${TEMPORAL_WEB_URL}.`, {
			status: 502,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}

	const headers = copyResponseHeaders(upstreamResponse);
	const responseInit = {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers
	};

	if (
		request.method !== 'HEAD' &&
		shouldRewriteResponse(upstreamResponse.headers.get('content-type'))
	) {
		return new Response(rewriteTemporalUiText(await upstreamResponse.text()), responseInit);
	}

	return new Response(upstreamResponse.body, responseInit);
}

export const GET: RequestHandler = proxyTemporalUi;
export const HEAD: RequestHandler = proxyTemporalUi;
export const POST: RequestHandler = proxyTemporalUi;
export const PUT: RequestHandler = proxyTemporalUi;
export const PATCH: RequestHandler = proxyTemporalUi;
export const DELETE: RequestHandler = proxyTemporalUi;
export const OPTIONS: RequestHandler = proxyTemporalUi;
