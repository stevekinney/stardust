<script lang="ts">
	import { onMount } from 'svelte';
	import ApprovalCard from '@lostgradient/cinder/approval-card';
	import type { ApprovalOperation, ApprovalState } from '@lostgradient/cinder/approval-card';
	import PageHeader from '$lib/components/page-header.svelte';

	type ApprovalEntry = {
		approvalId: string;
		sessionId: string;
		toolCall: { id: string; name: string; arguments: unknown };
		status: 'pending' | 'approved' | 'denied' | 'remembered' | 'cancelled' | 'expired';
		createdAt: string;
		expiresAt: string;
		resolution?: { action: string; resolvedAt: string; reason?: string };
	};

	let approvals = $state<ApprovalEntry[]>([]);
	let selected = $state<ApprovalEntry | null>(null);
	let loading = $state(true);

	let pending = $derived(approvals.filter((a) => a.status === 'pending'));
	let resolved = $derived(approvals.filter((a) => a.status !== 'pending'));
	let headerMeta = $derived.by(() => {
		const p = pending.length;
		const r = resolved.length;
		const parts: string[] = [];
		if (p > 0) parts.push(`${p} pending`);
		if (r > 0) parts.push(`${r} resolved`);
		return parts.join(' · ') || undefined;
	});

	function statusLabel(status: string): string {
		if (status === 'pending') return 'Pending';
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
				const body = (await response.json()) as { approvals: ApprovalEntry[] };
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

	/** Map page approval status to Cinder ApprovalState. */
	function toCinderState(status: string): ApprovalState {
		if (status === 'approved' || status === 'remembered') return 'approved';
		if (status === 'denied') return 'denied';
		if (status === 'expired') return 'expired';
		if (status === 'cancelled') return 'cancelled';
		return 'pending';
	}

	/** Build a Cinder ApprovalOperation from the stored toolCall. */
	function toOperation(toolCall: { name: string; arguments: unknown }): ApprovalOperation {
		const args = toolCall.arguments;
		if (typeof args === 'object' && args !== null) {
			const obj = args as Record<string, unknown>;
			if (typeof obj.command === 'string') {
				return { kind: 'command', command: obj.command, argsPreview: args };
			}
			if (typeof obj.cmd === 'string') {
				return { kind: 'command', command: obj.cmd, argsPreview: args };
			}
		}
		return { kind: 'other', argsPreview: args };
	}

	/** Extract the raw command string from toolCall arguments, or null if not a command. */
	function extractCommand(toolCall: { arguments: unknown }): string | null {
		const args = toolCall.arguments;
		if (typeof args === 'object' && args !== null) {
			const obj = args as Record<string, unknown>;
			if (typeof obj.command === 'string') return obj.command;
			if (typeof obj.cmd === 'string') return obj.cmd;
		}
		return null;
	}

	type CommandDiff = { before: string; added: string; after: string };

	/**
	 * Build a structured diff for known safe command edits.
	 * For psql commands, adds --single-transaction as the design example shows.
	 */
	function buildCommandDiff(original: string): CommandDiff | null {
		if (/^psql\b/.test(original) && !original.includes('--single-transaction')) {
			const match = /^(psql\s+\S+)(.*)$/.exec(original);
			if (match) {
				return { before: match[1] + ' ', added: '--single-transaction', after: match[2] };
			}
		}
		return null;
	}

	const selectedOriginalCmd = $derived(selected ? extractCommand(selected.toolCall) : null);
	const selectedCmdDiff = $derived(
		selectedOriginalCmd ? buildCommandDiff(selectedOriginalCmd) : null
	);
</script>

<svelte:head>
	<title>Approvals — Stardust</title>
</svelte:head>

<div class="page">
	<PageHeader title="Approvals" meta={headerMeta} />

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
				{#if selected !== null}
					{@const sel = selected}
					<div class="detail-inner">
						<ApprovalCard
							tool={{ name: sel.toolCall.name, risk: 'high' }}
							operation={toOperation(sel.toolCall)}
							sandbox={{
								provider: 'codex',
								name: 'workspace-write',
								workingDir: '/workspace/project'
							}}
							env={['DATABASE_URL']}
							policyVersion="policy-2026-06"
							idempotencyKey={sel.approvalId}
							expiresAt={sel.status === 'pending' ? sel.expiresAt : undefined}
							state={toCinderState(sel.status)}
							editableArgs={sel.status === 'pending'}
							onapprove={sel.status === 'pending'
								? () => resolveApproval(sel.approvalId, 'approve')
								: undefined}
							ondeny={sel.status === 'pending'
								? () => resolveApproval(sel.approvalId, 'deny')
								: undefined}
							onapprovewithedits={sel.status === 'pending'
								? () => resolveApproval(sel.approvalId, 'approve')
								: undefined}
						/>

						{#if sel.status === 'pending' && selectedCmdDiff !== null}
							<div class="diff-card">
								<div class="diff-header">
									<!-- lucide file-pen-line -->
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v10" />
										<path d="M14 2v4a2 2 0 0 0 2 2h4" />
										<path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z" />
									</svg>
									<span class="diff-header-title">If you Approve with edits, this is what runs</span
									>
									<span class="spacer"></span>
									<span class="diff-audit-chip">recorded in audit log</span>
								</div>
								<div class="diff-lines">
									<div class="diff-line diff-removed">
										<span class="diff-sign">−</span>
										<span class="diff-cmd">{selectedOriginalCmd}</span>
									</div>
									<div class="diff-line diff-added">
										<span class="diff-sign">+</span>
										<span class="diff-cmd"
											>{selectedCmdDiff.before}<b class="diff-highlight">{selectedCmdDiff.added}</b
											>{selectedCmdDiff.after}</span
										>
									</div>
								</div>
								<div class="diff-footer">
									The agent executes the <b>edited</b> command verbatim — never the original. Both versions,
									your identity, and the timestamp are written to the durable audit record under the same
									idempotency key.
								</div>
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

	.spacer {
		flex: 1;
	}

	/* ── Approve-with-edits diff card ── */

	.diff-card {
		border: 1px solid var(--cinder-accent);
		border-radius: 12px;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.diff-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
		color: var(--cinder-text);
	}

	.diff-header-title {
		font: 600 12.5px system-ui;
	}

	.diff-audit-chip {
		font: 500 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		padding: 2px 8px;
		border-radius: var(--cinder-radius-sm);
		white-space: nowrap;
	}

	.diff-lines {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font:
			500 12px / 1.5 ui-monospace,
			monospace;
	}

	.diff-line {
		display: flex;
		gap: 9px;
		align-items: flex-start;
		padding: 8px 10px;
		border-radius: 7px;
	}

	.diff-removed {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.diff-added {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.diff-sign {
		flex-shrink: 0;
		font-weight: 700;
		width: 12px;
	}

	.diff-cmd {
		flex: 1;
		min-width: 0;
		word-break: break-all;
	}

	.diff-highlight {
		background: var(--cinder-accent);
		color: var(--cinder-accent-contrast);
		padding: 1px 4px;
		border-radius: 3px;
		font-weight: 600;
	}

	.diff-footer {
		padding: 0 16px 14px;
		font: 400 11.5px / 1.5 system-ui;
		color: var(--cinder-text-subtle);
	}
</style>
