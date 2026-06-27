import { describe, expect, it } from 'vitest';
import { assertSafeFetchUrl, fetchWithSsrfGuard } from './ssrf';

describe('SSRF guard', () => {
	it.each([
		'http://127.0.0.1',
		'http://localhost',
		'http://10.0.0.1',
		'http://172.16.0.1',
		'http://192.168.1.1',
		'http://169.254.169.254',
		'file:///etc/passwd'
	])('blocks unsafe IPv4 URL %s', (url) => {
		expect(() => assertSafeFetchUrl(url)).toThrow();
	});

	it.each([
		// Loopback — was dead code before bracket-stripping fix
		'http://[::1]/',
		// Link-local fe80::/10
		'http://[fe80::1]/',
		'http://[fe80::dead:beef]/',
		// Unique-local fc00::/7 (fc and fd prefixes)
		'http://[fc00::1]/',
		'http://[fd12:3456::1]/',
		// IPv4-mapped loopback: ::ffff:127.0.0.1 → URL parser emits ::ffff:7f00:1
		'http://[::ffff:7f00:1]/',
		// IPv4-mapped metadata: ::ffff:169.254.169.254 → URL parser emits ::ffff:a9fe:a9fe
		'http://[::ffff:169.254.169.254]/',
		// IPv4-mapped private ranges
		'http://[::ffff:c0a8:101]/',
		'http://[::ffff:ac10:1]/'
	])('blocks unsafe IPv6 URL %s', (url) => {
		expect(() => assertSafeFetchUrl(url)).toThrow('blocked unsafe host');
	});

	it('allows valid public IPv6 addresses', () => {
		// 2001:db8::/32 is documentation/example range but passes the guard
		// (not in any private/loopback/link-local category)
		expect(() => assertSafeFetchUrl('http://[2001:db8::1]/')).not.toThrow();
		expect(() => assertSafeFetchUrl('https://[2606:4700::6810:84e5]/')).not.toThrow();
	});

	it('rechecks redirect targets', async () => {
		await expect(
			fetchWithSsrfGuard(
				{ url: 'https://example.test' },
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: 'http://169.254.169.254/latest/meta-data' }
					})
			)
		).rejects.toThrow('blocked unsafe host');
	});

	it('rechecks IPv6 redirect targets', async () => {
		await expect(
			fetchWithSsrfGuard(
				{ url: 'https://example.test' },
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: 'http://[fe80::1]/internal' }
					})
			)
		).rejects.toThrow('blocked unsafe host');
	});
});
