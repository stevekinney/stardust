import net from 'node:net';

const METADATA_HOST = '169.254.169.254';
const MAX_REDIRECTS = 5;

function parseIpv4(hostname: string): number[] | null {
	if (net.isIP(hostname) !== 4) return null;
	const parts = hostname.split('.').map((part) => Number(part));
	return parts.length === 4 &&
		parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: null;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = parseIpv4(hostname);
	if (!parts) return false;
	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized === 'localhost') return true;
	if (normalized === METADATA_HOST) return true;
	if (net.isIP(normalized) === 6) {
		return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd');
	}
	return isPrivateIpv4(normalized);
}

export function assertSafeFetchUrl(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`web.fetch only supports http and https URLs: ${url.protocol}`);
	}
	if (isBlockedHostname(url.hostname)) {
		throw new Error(`web.fetch blocked unsafe host: ${url.hostname}`);
	}
	return url;
}

export async function fetchWithSsrfGuard(
	input: { url: string; headers?: Record<string, string>; maxBytes?: number },
	fetcher: typeof fetch = fetch
): Promise<{ url: string; status: number; headers: Record<string, string>; body: string }> {
	let current = assertSafeFetchUrl(input.url);
	const maxBytes = input.maxBytes ?? 64_000;

	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		const response = await fetcher(current, {
			headers: input.headers,
			redirect: 'manual'
		});

		if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
			if (redirectCount === MAX_REDIRECTS) throw new Error('web.fetch exceeded redirect limit');
			current = assertSafeFetchUrl(new URL(response.headers.get('location')!, current).toString());
			continue;
		}

		const body = (await response.text()).slice(0, maxBytes);
		return {
			url: current.toString(),
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			body
		};
	}

	throw new Error('web.fetch exceeded redirect limit');
}
