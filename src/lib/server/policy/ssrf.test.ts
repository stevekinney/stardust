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
	])('blocks unsafe URL %s', (url) => {
		expect(() => assertSafeFetchUrl(url)).toThrow();
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
});
