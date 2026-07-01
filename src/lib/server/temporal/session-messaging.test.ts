import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { sendSessionMessage } from './session-messaging';

describe('sendSessionMessage', () => {
	it('starts (or reuses) the target session workflow and enqueues the message as a turn', async () => {
		const start = vi.fn(async () => undefined);
		const executeUpdate = vi.fn(async () => ({ accepted: true, runId: 'target-session-run-1' }));
		const getHandle = vi.fn(() => ({ executeUpdate }));
		const temporalClient = {
			workflow: { start, getHandle }
		} as unknown as Pick<Client, 'workflow'>;

		const result = await sendSessionMessage(
			{
				targetSessionKey: 'target-session',
				message: 'hello there',
				fromSessionKey: 'sender-session'
			},
			{ temporalClient }
		);

		expect(start).toHaveBeenCalledWith(
			'agentSessionWorkflow',
			expect.objectContaining({
				workflowId: 'agent-session:target-session',
				workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
				args: [{ sessionKey: 'target-session' }]
			})
		);
		expect(getHandle).toHaveBeenCalledWith('agent-session:target-session');
		expect(executeUpdate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ args: [{ message: 'hello there' }] })
		);
		expect(result).toEqual({
			accepted: true,
			runId: 'target-session-run-1',
			targetSessionKey: 'target-session'
		});
	});

	it('rejects a message sent from a session to itself', async () => {
		const temporalClient = {
			workflow: { start: vi.fn(), getHandle: vi.fn() }
		} as unknown as Pick<Client, 'workflow'>;

		await expect(
			sendSessionMessage(
				{ targetSessionKey: 'same-session', message: 'hello', fromSessionKey: 'same-session' },
				{ temporalClient }
			)
		).rejects.toThrow(/cannot target the sending session itself/);

		expect(temporalClient.workflow.start).not.toHaveBeenCalled();
	});

	it('allows the send when fromSessionKey is omitted', async () => {
		const start = vi.fn(async () => undefined);
		const executeUpdate = vi.fn(async () => ({ accepted: true, runId: 'target-session-run-1' }));
		const getHandle = vi.fn(() => ({ executeUpdate }));
		const temporalClient = {
			workflow: { start, getHandle }
		} as unknown as Pick<Client, 'workflow'>;

		await expect(
			sendSessionMessage({ targetSessionKey: 'target-session', message: 'hi' }, { temporalClient })
		).resolves.toMatchObject({ targetSessionKey: 'target-session' });
	});
});
