<script lang="ts">
	import EmptyState from '@lostgradient/cinder/empty-state';
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
		<EmptyState
			title="No pending approvals"
			description="No pending approvals for this run."
			headingLevel={3}
		/>
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
</style>
