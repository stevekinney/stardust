import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const mocks = vi.hoisted(() => ({
	findById: vi.fn(),
	executeUpdate: vi.fn(),
	getHandle: vi.fn()
}));

vi.mock('$lib/server/db/client', () => ({
	db: {}
}));

vi.mock('$lib/server/policy/approvals', () => ({
	ApprovalsRepository: class {
		findById = mocks.findById;
	}
}));

vi.mock('$lib/server/temporal/client', () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			getHandle: mocks.getHandle
		}
	})
}));

describe('approval resolve route', () => {
	it('routes the approval decision through the session workflow (not the run directly)', async () => {
		mocks.findById.mockResolvedValueOnce({
			approvalId: 'approval-001',
			sessionId: 'session-001',
			runId: 'run-001'
		});
		mocks.executeUpdate.mockResolvedValueOnce({
			approvalId: 'approval-001',
			terminalState: 'approved',
			canonicalArguments: { path: 'notes.txt', content: 'approved' }
		});
		mocks.getHandle.mockReturnValueOnce({
			executeUpdate: mocks.executeUpdate
		});

		const response = await POST({
			params: { approvalId: 'approval-001' },
			request: new Request('http://localhost/api/approvals/approval-001/resolve', {
				method: 'POST',
				body: JSON.stringify({
					action: 'approve_with_edits',
					editedArguments: { path: 'notes.txt', content: 'approved' },
					remember: true
				})
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		// Must target the session workflow, not the run directly.
		expect(mocks.getHandle).toHaveBeenCalledWith('agent-session:session-001');
		expect(mocks.getHandle).not.toHaveBeenCalledWith('agent-run:run-001');
		expect(mocks.executeUpdate).toHaveBeenCalledWith(expect.anything(), {
			args: [
				{
					approvalId: 'approval-001',
					action: 'approve_with_edits',
					editedArguments: { path: 'notes.txt', content: 'approved' },
					remember: true,
					actor: 'user'
				}
			]
		});
		expect(await response.json()).toEqual({
			approvalId: 'approval-001',
			resolution: expect.objectContaining({
				terminalState: 'approved'
			})
		});
	});
});
