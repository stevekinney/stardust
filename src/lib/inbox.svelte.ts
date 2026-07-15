import type { ApprovalEntry, InboxMemoryCandidate } from '$lib/types';

const POLL_INTERVAL_MS = 10_000;

/**
 * Shared reactive inbox state: pending approvals and unconfirmed memory
 * candidates across every session. Consumed by the top-nav badge and the inbox
 * page. The root layout owns its polling lifecycle.
 */
export class InboxStore {
	approvals = $state.raw<ApprovalEntry[]>([]);
	candidates = $state.raw<InboxMemoryCandidate[]>([]);
	loaded = $state(false);

	get pendingApprovals(): ApprovalEntry[] {
		return this.approvals.filter((approval) => approval.status === 'pending');
	}

	get total(): number {
		return this.pendingApprovals.length + this.candidates.length;
	}

	/** Fetch approvals and memory candidates in parallel; failures leave prior state intact. */
	async refresh(): Promise<void> {
		const [approvals, candidates] = await Promise.all([fetchApprovals(), fetchMemoryCandidates()]);
		if (approvals !== null) this.approvals = approvals;
		if (candidates !== null) this.candidates = candidates;
		this.loaded = true;
	}

	/** Refresh immediately, then poll until the returned cleanup function runs. */
	startPolling(): () => void {
		void this.refresh();
		const interval = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}
}

async function fetchApprovals(): Promise<ApprovalEntry[] | null> {
	try {
		const response = await fetch('/api/approvals');
		if (!response.ok) return null;
		const body = (await response.json()) as { approvals: ApprovalEntry[] };
		return body.approvals;
	} catch {
		return null;
	}
}

async function fetchMemoryCandidates(): Promise<InboxMemoryCandidate[] | null> {
	try {
		const response = await fetch('/api/memory');
		if (!response.ok) return null;
		const body = (await response.json()) as { candidates: InboxMemoryCandidate[] };
		return body.candidates;
	} catch {
		return null;
	}
}

export const inbox = new InboxStore();
