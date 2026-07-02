import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxStore } from './inbox.svelte';
import type { ApprovalEntry, InboxMemoryCandidate } from '$lib/types';

function makeApproval(overrides: Partial<ApprovalEntry> = {}): ApprovalEntry {
	return {
		approvalId: 'apr-001',
		sessionId: 'sess-key-1',
		toolCall: { id: 'call-1', name: 'run_command', arguments: {} },
		status: 'pending',
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides
	};
}

function makeCandidate(overrides: Partial<InboxMemoryCandidate> = {}): InboxMemoryCandidate {
	return {
		id: 'cand-001',
		sessionId: 'uuid-1',
		sessionKey: 'sess-key-1',
		runId: 'run-1',
		layer: 'durable',
		content: 'Prefers Bun over npm',
		tags: [],
		reason: null,
		createdAt: new Date().toISOString(),
		...overrides
	};
}

function mockEndpoints(approvals: ApprovalEntry[], candidates: InboxMemoryCandidate[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/api/approvals')) {
				return new Response(JSON.stringify({ approvals }), { status: 200 });
			}
			if (url.endsWith('/api/memory')) {
				return new Response(JSON.stringify({ notes: [], candidates }), { status: 200 });
			}
			return new Response('not found', { status: 404 });
		})
	);
}

describe('InboxStore', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('counts pending approvals and candidates after a refresh', async () => {
		mockEndpoints(
			[makeApproval(), makeApproval({ approvalId: 'apr-002', status: 'approved' })],
			[makeCandidate()]
		);

		const store = new InboxStore();
		await store.refresh();

		expect(store.pendingApprovals).toHaveLength(1);
		expect(store.candidates).toHaveLength(1);
		expect(store.total).toBe(2);
		expect(store.loaded).toBe(true);
	});

	it('keeps prior state when a poll fails', async () => {
		mockEndpoints([makeApproval()], [makeCandidate()]);
		const store = new InboxStore();
		await store.refresh();
		expect(store.total).toBe(2);

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 }))
		);
		await store.refresh();

		expect(store.total).toBe(2);
	});
});
