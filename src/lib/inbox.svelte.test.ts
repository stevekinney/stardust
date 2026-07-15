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
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('does not fetch or start polling when constructed', () => {
		vi.useFakeTimers();
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);

		new InboxStore();

		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('refreshes immediately while polling and stops after cleanup', async () => {
		vi.useFakeTimers();
		mockEndpoints([], []);
		const store = new InboxStore();

		const stopPolling = store.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetch).toHaveBeenCalledTimes(4);

		stopPolling();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it('waits for a slow refresh before scheduling the next poll', async () => {
		vi.useFakeTimers();
		let finishFirstRefresh: () => void = () => undefined;
		const firstRefresh = new Promise<void>((resolve) => {
			finishFirstRefresh = resolve;
		});
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (fetch.mock.calls.length <= 2) await firstRefresh;
			const url = String(input);
			if (url.endsWith('/api/approvals')) {
				return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
			}
			return new Response(JSON.stringify({ notes: [], candidates: [] }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetch);
		const store = new InboxStore();

		const stopPolling = store.startPolling();
		expect(fetch).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetch).toHaveBeenCalledTimes(2);

		finishFirstRefresh();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetch).toHaveBeenCalledTimes(4);

		stopPolling();
		stopPolling();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetch).toHaveBeenCalledTimes(4);
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
