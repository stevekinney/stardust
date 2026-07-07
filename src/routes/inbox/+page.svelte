<script lang="ts">
	import { onMount } from 'svelte';
	import InboxNeedsYou from '$lib/components/inbox-needs-you.svelte';
	import InboxReview from '$lib/components/inbox-review.svelte';
	import InboxFyi, { type FyiItem } from '$lib/components/inbox-fyi.svelte';
	import { inbox } from '$lib/inbox.svelte';
	import { relativeTime } from '$lib/session-display';
	import type { InboxMemoryCandidate, ScheduleProjection } from '$lib/types';

	type ApprovalResolveAction = 'approve' | 'approve_with_edits' | 'deny';

	type ResolvedNotice = {
		approvalId: string;
		action: ApprovalResolveAction;
		toolName: string;
	};

	let resolvedNow = $state<ResolvedNotice[]>([]);
	let candidateDecisions = $state<Record<string, 'saved' | 'discarded'>>({});
	let fyiItems = $state<FyiItem[]>([]);

	onMount(() => {
		void inbox.refresh();
		void loadScheduleFyi();
	});

	async function resolveApproval(
		approvalId: string,
		action: ApprovalResolveAction,
		editedArguments?: unknown
	) {
		const approval = inbox.pendingApprovals.find((entry) => entry.approvalId === approvalId);
		try {
			const response = await fetch(`/api/approvals/${approvalId}/resolve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					action === 'approve_with_edits' ? { action, editedArguments } : { action }
				)
			});
			if (!response.ok) return;
			resolvedNow = [
				...resolvedNow,
				{ approvalId, action, toolName: approval?.toolCall.name ?? 'tool' }
			];
		} finally {
			void inbox.refresh();
		}
	}

	async function saveCandidate(candidate: InboxMemoryCandidate) {
		if (!candidate.sessionKey) return;
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(candidate.sessionKey)}/memory/candidates/${encodeURIComponent(candidate.id)}`,
			{ method: 'POST' }
		);
		if (response.ok) {
			candidateDecisions = { ...candidateDecisions, [candidate.id]: 'saved' };
		}
	}

	async function discardCandidate(candidate: InboxMemoryCandidate) {
		if (!candidate.sessionKey) return;
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(candidate.sessionKey)}/memory/candidates/${encodeURIComponent(candidate.id)}`,
			{ method: 'DELETE' }
		);
		if (response.ok) {
			candidateDecisions = { ...candidateDecisions, [candidate.id]: 'discarded' };
		}
	}

	/** Recent successful schedule fires become "handled without you" notices. */
	async function loadScheduleFyi() {
		try {
			const response = await fetch('/api/schedules');
			if (!response.ok) return;
			const body = (await response.json()) as { schedules: ScheduleProjection[] };
			fyiItems = body.schedules
				.flatMap((schedule) =>
					schedule.fireEvents
						.filter((fire) => fire.status === 'accepted' && fire.actualTriggerTime)
						.map((fire) => ({
							id: fire.id,
							kind: 'schedule-fire' as const,
							text: `${schedule.name} fired ${relativeTime(fire.actualTriggerTime)} — run accepted`,
							meta: `schedule:${schedule.name}${schedule.nextRunAt ? ` · next fire ${relativeTime(schedule.nextRunAt).replace(' ago', '')}` : ''}`,
							sessionKey: fire.targetSessionKey,
							sortKey: fire.actualTriggerTime
						}))
				)
				.sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
				.slice(0, 5)
				.map(({ id, kind, text, meta, sessionKey }) => ({ id, kind, text, meta, sessionKey }));
		} catch {
			// Non-fatal — the section renders its empty state
		}
	}

	/** Candidates still pending plus ones decided during this visit (shown struck through). */
	const visibleCandidates = $derived(
		inbox.candidates.filter(
			(candidate) => candidate.sessionKey !== null || candidateDecisions[candidate.id]
		)
	);
</script>

<svelte:head>
	<title>Inbox — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-head">
		<h1 class="page-title">Inbox</h1>
		<span class="page-sub">Everything waiting on you, across every session.</span>
	</div>

	<InboxNeedsYou approvals={inbox.pendingApprovals} {resolvedNow} onResolve={resolveApproval} />

	<InboxReview
		candidates={visibleCandidates}
		decisions={candidateDecisions}
		onSave={saveCandidate}
		onDiscard={discardCandidate}
	/>

	<InboxFyi items={fyiItems} />
</div>

<style>
	.page {
		max-width: var(--cinder-content-width);
		margin: 0 auto;
		padding: 28px 32px 48px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.page-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.page-title {
		margin: 0;
		font-size: var(--cinder-text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.page-sub {
		font-size: 12.5px;
		color: var(--cinder-text-subtle);
	}
</style>
