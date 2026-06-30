<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';

	type ApprovalCard = {
		approvalId: string;
		sessionId: string;
		toolCall: { id: string; name: string; arguments: unknown };
		status: 'pending' | 'approved' | 'denied' | 'remembered' | 'cancelled' | 'expired';
		createdAt: string;
		expiresAt: string;
		resolution?: { action: string; resolvedAt: string; reason?: string };
	};

	let approvals = $state<ApprovalCard[]>([]);
	let selected = $state<ApprovalCard | null>(null);
	let loading = $state(true);

	let pending = $derived(approvals.filter((a) => a.status === 'pending'));
	let resolved = $derived(approvals.filter((a) => a.status !== 'pending'));
	let headerMeta = $derived.by(() => {
		const p = pending.length;
		const r = resolved.length;
		const parts: string[] = [];
		if (p > 0) parts.push(`${p} pending`);
		if (r > 0) parts.push(`${r} resolved`);
		return parts.join(' · ') || 'No approvals';
	});

	function statusLabel(status: string): string {
		if (status === 'pending') return 'High risk';
		if (status === 'approved') return 'Approved';
		if (status === 'denied') return 'Denied';
		if (status === 'remembered') return 'Remembered';
		if (status === 'cancelled') return 'Cancelled';
		return 'Expired';
	}

	function timeAgo(iso: string): string {
		const ms = Date.now() - new Date(iso).getTime();
		const minutes = Math.floor(ms / 60000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	function expiryRemaining(iso: string): string {
		const ms = new Date(iso).getTime() - Date.now();
		if (ms <= 0) return 'expired';
		const minutes = Math.floor(ms / 60000);
		if (minutes < 60) return `${minutes}m left`;
		return `${Math.floor(minutes / 60)}h left`;
	}

	function shortSessionId(id: string): string {
		return id.length > 8 ? `ses_${id.slice(0, 4)}` : id;
	}

	async function resolveApproval(approvalId: string, action: 'approve' | 'deny') {
		await fetch(`/api/approvals/${approvalId}/resolve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		});
		await loadApprovals();
	}

	async function loadApprovals() {
		try {
			const response = await fetch('/api/approvals');
			if (response.ok) {
				const body = (await response.json()) as { approvals: ApprovalCard[] };
				approvals = body.approvals;
				if (!selected && approvals.length > 0) {
					selected = approvals[0];
				}
			}
		} catch {
			// Non-fatal
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadApprovals();
		const interval = setInterval(() => void loadApprovals(), 10_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Approvals — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<h1 class="page-title">Approvals</h1>
		<span class="page-meta">{headerMeta}</span>
	</div>

	{#if loading}
		<div class="page-body"><span class="page-meta">Loading…</span></div>
	{:else if approvals.length === 0}
		<div class="page-body">
			<div class="empty">
				<div class="empty-icon">
					<svg
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
						/>
						<path d="M12 8v4" />
						<path d="M12 16h.01" />
					</svg>
				</div>
				<h2 class="empty-heading">All clear</h2>
				<p class="empty-description">
					When an agent session reaches a risky action, it pauses on a durable wait and the approval
					appears here. Nothing has been flagged yet.
				</p>
			</div>
		</div>
	{:else}
		<div class="split">
			<div class="sidebar">
				{#each approvals as approval (approval.approvalId)}
					<button
						class="approval-card"
						class:active={selected?.approvalId === approval.approvalId}
						class:resolved={approval.status !== 'pending'}
						onclick={() => (selected = approval)}
					>
						<div class="card-top">
							<span
								class="badge"
								class:badge-danger={approval.status === 'pending'}
								class:badge-success={approval.status === 'approved'}
								class:badge-neutral={approval.status === 'denied' ||
									approval.status === 'cancelled' ||
									approval.status === 'expired'}
								class:badge-warning={approval.status === 'remembered'}
							>
								{statusLabel(approval.status)}
							</span>
							<span class="card-time">
								{approval.status === 'pending'
									? expiryRemaining(approval.expiresAt)
									: timeAgo(approval.resolution?.resolvedAt ?? approval.createdAt)}
							</span>
						</div>
						<div class="card-tool">{approval.toolCall.name}</div>
						<div class="card-session">{shortSessionId(approval.sessionId)}</div>
					</button>
				{/each}
			</div>
			<div class="detail">
				{#if selected}
					<div class="detail-inner">
						<div class="detail-header">
							<span
								class="badge"
								class:badge-danger={selected.status === 'pending'}
								class:badge-success={selected.status === 'approved'}
								class:badge-neutral={selected.status === 'denied' ||
									selected.status === 'cancelled' ||
									selected.status === 'expired'}
								class:badge-warning={selected.status === 'remembered'}
							>
								{statusLabel(selected.status)}
							</span>
							<h2 class="detail-tool">{selected.toolCall.name}</h2>
						</div>

						<div class="detail-meta">
							<div class="meta-row">
								<span class="meta-label">Session</span>
								<span class="meta-value mono">{shortSessionId(selected.sessionId)}</span>
							</div>
							<div class="meta-row">
								<span class="meta-label">Approval ID</span>
								<span class="meta-value mono">{selected.approvalId.slice(0, 12)}</span>
							</div>
							<div class="meta-row">
								<span class="meta-label">Created</span>
								<span class="meta-value">{timeAgo(selected.createdAt)}</span>
							</div>
							{#if selected.status === 'pending'}
								<div class="meta-row">
									<span class="meta-label">Expires</span>
									<span class="meta-value">{expiryRemaining(selected.expiresAt)}</span>
								</div>
							{/if}
						</div>

						<div class="detail-args">
							<div class="args-header">Proposed arguments</div>
							<pre class="args-body">{JSON.stringify(selected.toolCall.arguments, null, 2)}</pre>
						</div>

						{#if selected.status === 'pending'}
							<div class="detail-actions">
								<Button
									variant="primary"
									size="sm"
									label="Approve"
									onclick={() => resolveApproval(selected!.approvalId, 'approve')}
								/>
								<Button
									variant="soft-danger"
									size="sm"
									label="Deny"
									onclick={() => resolveApproval(selected!.approvalId, 'deny')}
								/>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.page-header {
		flex: none;
		padding: 18px 22px 14px;
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.page-title {
		font: 650 20px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.page-meta {
		font: 500 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.page-body {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px;
	}

	.empty {
		text-align: center;
		max-width: 380px;
	}

	.empty-icon {
		width: 52px;
		height: 52px;
		border-radius: 14px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border);
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto 16px;
		color: var(--cinder-text-subtle);
	}

	.empty-heading {
		font: 650 18px system-ui;
		margin: 0 0 8px;
		color: var(--cinder-text);
	}

	.empty-description {
		font: 400 13px/1.6 system-ui;
		margin: 0;
		color: var(--cinder-text-muted);
	}

	.split {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.sidebar {
		width: 288px;
		flex: none;
		border-right: 1px solid var(--cinder-border);
		overflow: auto;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.approval-card {
		all: unset;
		cursor: pointer;
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		padding: 11px 12px;
		display: block;
		text-align: left;
	}

	.approval-card.active {
		border: 1.5px solid var(--cinder-accent);
		background: var(--cinder-surface-inset);
	}

	.approval-card.resolved {
		opacity: 0.7;
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.card-time {
		font: 500 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-left: auto;
	}

	.card-tool {
		font: 600 12.5px system-ui;
		margin-top: 8px;
		color: var(--cinder-text);
	}

	.card-session {
		font: 500 10.5px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 3px;
	}

	.badge {
		display: inline-block;
		font: 600 10px system-ui;
		padding: 2px 7px;
		border-radius: 6px;
		text-transform: capitalize;
	}

	.badge-danger {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.badge-success {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.badge-neutral {
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.badge-warning {
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	.detail {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.detail-inner {
		width: 100%;
		max-width: 660px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.detail-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.detail-tool {
		font: 650 18px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.detail-meta {
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.meta-row {
		display: flex;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.meta-row:last-child {
		border-bottom: none;
	}

	.meta-label {
		font: 500 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.meta-value {
		font: 500 12px system-ui;
		color: var(--cinder-text);
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	.detail-args {
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.args-header {
		font: 600 11px system-ui;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 11px 14px;
		color: var(--cinder-text-subtle);
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.args-body {
		margin: 0;
		padding: 12px 14px;
		font: 400 12px var(--cinder-font-mono);
		color: var(--cinder-text);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.detail-actions {
		display: flex;
		gap: 8px;
	}
</style>
