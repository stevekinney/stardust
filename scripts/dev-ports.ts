import { createServer } from 'node:net';

const loopbackHosts = ['127.0.0.1', '::1'] as const;

/** Resolve true if a TCP listener can bind the port on every loopback interface Vite may use. */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
	const results = await Promise.all(loopbackHosts.map((host) => canBindPort(port, host)));
	return results.every(Boolean);
}

function canBindPort(port: number, host: (typeof loopbackHosts)[number]): Promise<boolean> {
	return new Promise((resolve) => {
		const tester = createServer();
		tester.once('error', (error: NodeJS.ErrnoException) => {
			if (host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) {
				resolve(true);
				return;
			}
			resolve(false);
		});
		tester.once('listening', () => tester.close(() => resolve(true)));
		tester.listen(port, host);
	});
}

// Ports handed out during this run, so a fallback never reassigns one already
// chosen for another service (the preferred ranges are adjacent).
export const reservedPorts = new Set<number>();

/** Find the first free port at or after `preferred`, skipping already-reserved ones. */
export async function reserveFreePort(
	preferred: number,
	reserved = reservedPorts
): Promise<number> {
	for (let port = preferred; port < preferred + 100; port++) {
		if (reserved.has(port)) continue;
		if (await isLoopbackPortFree(port)) {
			reserved.add(port);
			return port;
		}
	}
	throw new Error(`[dev] No free port found near ${preferred}.`);
}
