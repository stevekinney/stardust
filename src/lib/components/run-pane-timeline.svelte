<script lang="ts">
	import RunStepTimeline from '@lostgradient/cinder/run-step-timeline';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import { transcriptToRunSteps } from '$lib/run-inspector-adapters';

	type Props = {
		inspector: RunInspectorProjection;
		running: boolean;
		hasPendingApproval: boolean;
	};

	let { inspector, running, hasPendingApproval }: Props = $props();

	const steps = $derived(transcriptToRunSteps(inspector, { running, hasPendingApproval }));
</script>

{#if steps.length > 0}
	<RunStepTimeline {steps} label="Run steps" />
{:else}
	<p class="empty">No steps recorded for this run yet.</p>
{/if}

<style>
	.empty {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
