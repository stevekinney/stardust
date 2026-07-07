import { describe, expect, it, vi } from 'vitest';
import { bootstrapSessionPage, type SessionPageBootstrapDeps } from './session-page-bootstrap';

function makeDeps(overrides: Partial<SessionPageBootstrapDeps> = {}) {
	return {
		fresh: false,
		startMessage: null,
		loadPendingApproval: vi.fn().mockResolvedValue(undefined),
		loadTranscript: vi.fn().mockResolvedValue(undefined),
		loadLatestRunInspector: vi.fn().mockResolvedValue(undefined),
		submitFirstTurn: vi.fn().mockResolvedValue(undefined),
		...overrides
	};
}

describe('bootstrapSessionPage', () => {
	it('regression BUG-001: fires no detail fetches for a brand-new session with no message yet', async () => {
		// A session minted by "New session" (hero button or ⌘K palette) has no
		// DB row until the user's first composer submit creates it. Fetching
		// /approvals, /transcript, or /runs before that produces a transient
		// 404 (BUG-001). None of these loaders should be called in this state.
		const deps = makeDeps({ fresh: true, startMessage: null });

		await bootstrapSessionPage(deps);

		expect(deps.loadPendingApproval).not.toHaveBeenCalled();
		expect(deps.loadTranscript).not.toHaveBeenCalled();
		expect(deps.loadLatestRunInspector).not.toHaveBeenCalled();
		expect(deps.submitFirstTurn).not.toHaveBeenCalled();
	});

	it('submits the first turn (and only the first turn) for a fresh session with a start message', async () => {
		const deps = makeDeps({ fresh: true, startMessage: 'Refactor the auth guards' });

		await bootstrapSessionPage(deps);

		expect(deps.submitFirstTurn).toHaveBeenCalledExactlyOnceWith('Refactor the auth guards');
		expect(deps.loadPendingApproval).not.toHaveBeenCalled();
		expect(deps.loadTranscript).not.toHaveBeenCalled();
		expect(deps.loadLatestRunInspector).not.toHaveBeenCalled();
	});

	it('loads pending approval, transcript, and run inspector for an existing session revisit', async () => {
		const deps = makeDeps({ fresh: false, startMessage: null });

		await bootstrapSessionPage(deps);

		expect(deps.loadPendingApproval).toHaveBeenCalledOnce();
		expect(deps.loadTranscript).toHaveBeenCalledOnce();
		expect(deps.loadLatestRunInspector).toHaveBeenCalledOnce();
		expect(deps.submitFirstTurn).not.toHaveBeenCalled();
	});

	it('loads the run inspector only after the transcript resolves, for an existing session', async () => {
		const order: string[] = [];
		const deps = makeDeps({
			fresh: false,
			startMessage: null,
			loadTranscript: vi.fn().mockImplementation(async () => {
				order.push('transcript');
			}),
			loadLatestRunInspector: vi.fn().mockImplementation(async () => {
				order.push('run-inspector');
			})
		});

		await bootstrapSessionPage(deps);

		expect(order).toEqual(['transcript', 'run-inspector']);
	});
});
