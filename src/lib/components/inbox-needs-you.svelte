<script lang="ts">
	import { resolve } from '$app/paths';
	import ApprovalCard from '@lostgradient/cinder/approval-card';
	import { toApprovalOperation } from './conversation-view.svelte';
	import type { ApprovalEntry } from '$lib/types';

	type ResolvedNotice = { approvalId: string; action: 'approve' | 'deny'; toolName: string };

	type Props = {
		approvals: ApprovalEntry[];
		/** Approvals resolved during this visit, shown as settled banners. */
		resolvedNow: ResolvedNotice[];
		onResolve: (approvalId: string, action: 'approve' | 'deny') => void;
	};

	let { approvals, resolvedNow, onResolve }: Props = $props();
</script>

<section class="group" aria-label="Needs you now">
	<span class="group-label needs">Needs you now</span>

	{#each resolvedNow as notice (notice.approvalId)}
		<div class="settled" class:denied={notice.action === 'deny'} role="status">
			<span class="settled-text">
				{notice.action === 'approve'
					? `Approved — the signal woke the workflow and ${notice.toolName} is running`
					: 'Denied — the run was told no and is wrapping up safely'}
			</span>
			<span class="spacer"></span>
			<span class="settled-meta">signal delivered · {notice.approvalId.slice(0, 12)}</span>
		</div>
	{/each}

	{#each approvals as approval (approval.approvalId)}
		<div class="approval">
			<div class="approval-context">
				<span>from</span>
				<a
					href={resolve(`/sessions/${encodeURIComponent(approval.sessionId)}`)}
					class="session-link"
				>
					{approval.sessionId}
				</a>
				<span>·</span>
				<span>signal human_approval · run paused on a durable wait, nothing has executed</span>
			</div>
			<ApprovalCard
				tool={{ name: approval.toolCall.name, risk: 'high' }}
				operation={toApprovalOperation(approval.toolCall)}
				policyVersion="policy-2026-06"
				idempotencyKey={approval.approvalId}
				expiresAt={approval.expiresAt}
				state="pending"
				editableArgs={true}
				onapprove={() => onResolve(approval.approvalId, 'approve')}
				ondeny={() => onResolve(approval.approvalId, 'deny')}
				onapprovewithedits={() => onResolve(approval.approvalId, 'approve')}
			/>
		</div>
	{/each}

	{#if approvals.length === 0 && resolvedNow.length === 0}
		<p class="empty">Nothing needs you right now.</p>
	{/if}
</section>

<style>
	.group {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.group-label {
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.group-label.needs {
		color: var(--cinder-color-warning-fg);
	}

	.spacer {
		flex: 1;
	}

	.approval {
		display: grid;
		gap: 6px;
	}

	.approval-context {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		min-width: 0;
	}

	.session-link {
		color: var(--cinder-accent-text);
		font-weight: 600;
		text-decoration: none;
	}

	.session-link:hover {
		text-decoration: underline;
	}

	.settled {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--cinder-color-success-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-success-bg);
	}

	.settled-text {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--cinder-color-success-fg);
	}

	.settled-meta {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-color-success-fg);
		opacity: 0.8;
	}

	.settled.denied {
		border-color: var(--cinder-border-muted);
		background: var(--cinder-surface-inset);
	}

	.settled.denied .settled-text,
	.settled.denied .settled-meta {
		color: var(--cinder-text-subtle);
	}

	.empty {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
