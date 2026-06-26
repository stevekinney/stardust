<script lang="ts">
	import type { ApprovalCardState, ApprovalResolutionInput } from '$lib/types';
	import ApprovalCard from './ApprovalCard.svelte';

	type Props = {
		approvals: ApprovalCardState[];
		onResolve?: (resolution: ApprovalResolutionInput) => void | Promise<void>;
	};

	let { approvals, onResolve }: Props = $props();

	const isEmpty = $derived(approvals.length === 0);
</script>

<section class="approval-center" aria-labelledby="approval-center-heading">
	<h2 id="approval-center-heading">Approval Center</h2>

	{#if isEmpty}
		<p class="empty muted">No pending approvals for this run.</p>
	{:else}
		<div class="approval-list">
			{#each approvals as approval (approval.approvalId)}
				<ApprovalCard {approval} {onResolve} />
			{/each}
		</div>
	{/if}
</section>

<style>
	.approval-center {
		display: grid;
		gap: 1rem;
	}

	h2 {
		margin: 0 0 0.25rem;
	}

	.approval-list {
		display: grid;
		gap: 1rem;
	}

	.empty {
		margin: 0;
		font-size: 0.9rem;
	}

	.muted {
		color: color-mix(in srgb, CanvasText 55%, transparent);
	}
</style>
