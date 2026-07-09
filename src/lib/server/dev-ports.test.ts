import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { reserveFreePort } from '../../../scripts/dev-ports';

const occupiedServers: Server[] = [];

function listen(host: '127.0.0.1' | '::1', port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, host, () => {
			occupiedServers.push(server);
			resolve(server);
		});
	});
}

async function tryListen(host: '127.0.0.1' | '::1', port: number): Promise<Server | null> {
	try {
		return await listen(host, port);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) {
			return null;
		}
		if (code === 'EADDRINUSE') {
			return null;
		}
		throw error;
	}
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function findFreePort(host: '127.0.0.1' | '::1'): Promise<number> {
	const server = await listen(host, 0);
	const address = server.address();
	await close(server);
	occupiedServers.splice(occupiedServers.indexOf(server), 1);
	if (!address || typeof address === 'string')
		throw new Error(`Could not reserve ${host} test port.`);
	return address.port;
}

async function occupyIPv6PortThatIsFreeOnIPv4(): Promise<number | null> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const preferredPort = await findFreePort('127.0.0.1');
		const server = await tryListen('::1', preferredPort);
		if (server) return preferredPort;
	}
	return null;
}

afterEach(async () => {
	await Promise.all(occupiedServers.splice(0).map(close));
});

describe('development port selection', () => {
	it('skips the preferred app port when IPv4 loopback already occupies it', async () => {
		const preferredPort = await findFreePort('127.0.0.1');
		await listen('127.0.0.1', preferredPort);

		await expect(reserveFreePort(preferredPort, new Set())).resolves.not.toBe(preferredPort);
	});

	it('skips the preferred app port when IPv6 loopback already occupies it', async () => {
		const preferredPort = await occupyIPv6PortThatIsFreeOnIPv4();
		if (preferredPort == null) return;

		await expect(reserveFreePort(preferredPort, new Set())).resolves.not.toBe(preferredPort);
	});
});
