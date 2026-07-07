import { describe, expect, it, vi } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTimeSkippingEnvironment } from './test-environment';

const connectFailure = () =>
	new Error(
		'Failed to start ephemeral server: Failed connecting to test server after 5 seconds, last error: Some(TonicTransportError(...))'
	);

const fakeEnvironment = {} as TestWorkflowEnvironment;

describe('createTimeSkippingEnvironment', () => {
	it('returns the environment when the first boot succeeds', async () => {
		const create = vi.fn().mockResolvedValue(fakeEnvironment);

		await expect(createTimeSkippingEnvironment(create)).resolves.toBe(fakeEnvironment);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('retries the ephemeral-server connect timeout and succeeds', async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce(connectFailure())
			.mockResolvedValueOnce(fakeEnvironment);

		await expect(createTimeSkippingEnvironment(create)).resolves.toBe(fakeEnvironment);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('gives up after three connect-timeout attempts and rethrows the last error', async () => {
		const create = vi.fn().mockRejectedValue(connectFailure());

		await expect(createTimeSkippingEnvironment(create)).rejects.toThrow(
			'Failed connecting to test server'
		);
		expect(create).toHaveBeenCalledTimes(3);
	});

	it('propagates non-connect failures immediately without retrying', async () => {
		const create = vi.fn().mockRejectedValue(new Error('workflow bundle failed to compile'));

		await expect(createTimeSkippingEnvironment(create)).rejects.toThrow(
			'workflow bundle failed to compile'
		);
		expect(create).toHaveBeenCalledTimes(1);
	});
});
