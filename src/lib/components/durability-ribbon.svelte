<script lang="ts">
	import type { DurabilityEvidence } from '$lib/server/observability/projection';

	type Props = {
		evidence?: DurabilityEvidence | null;
		compact?: boolean;
	};

	let { evidence = null, compact = false }: Props = $props();

	function formatValue(value: number | null | undefined): string {
		return value == null ? '—' : String(value);
	}
</script>

<div class="ribbon" class:compact role="status" aria-label="Durability evidence">
	<div class="rib">
		<span class="rib-n">{formatValue(evidence?.streamGapCount)}</span>
		<span class="rib-l">stream gaps</span>
	</div>
	<div class="rib">
		<span class="rib-n rib-success">{formatValue(evidence?.retryAttemptCount)}</span>
		<span class="rib-l">retry attempts</span>
	</div>
	<div class="rib">
		<span class="rib-n">{formatValue(evidence?.heartbeatBackedCommandCount)}</span>
		<span class="rib-l">heartbeat commands</span>
	</div>
	<div class="rib">
		<span class="rib-n rib-accent">{formatValue(evidence?.latestTranscriptSequence)}</span>
		<span class="rib-l">transcript cursor</span>
	</div>
	{#if !compact}
		<div class="rib">
			<span class="rib-n">{formatValue(evidence?.idempotencyReplayCount)}</span>
			<span class="rib-l">idempotency rows</span>
		</div>
		<div class="rib">
			<span class="rib-n">{formatValue(evidence?.scheduleFireCount)}</span>
			<span class="rib-l">schedule fires</span>
		</div>
	{/if}
</div>

<style>
	.ribbon {
		display: flex;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: linear-gradient(180deg, var(--cinder-surface-inset) 0%, var(--cinder-surface) 100%);
		flex: none;
		overflow-x: auto;
	}

	.rib {
		flex: 1 0 7rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 10px 8px;
		min-width: 0;
	}

	.compact .rib {
		flex-basis: 5.5rem;
		padding: 8px 6px;
	}

	.rib + .rib {
		border-left: 1px solid var(--cinder-border-muted);
	}

	.rib-n {
		font: 700 17px system-ui;
		color: var(--cinder-text);
		font-family: var(--cinder-font-mono);
	}

	.rib-success {
		color: var(--cinder-success);
	}

	.rib-accent {
		color: var(--cinder-accent-text);
	}

	.rib-l {
		font: 400 9.5px system-ui;
		color: var(--cinder-text-subtle);
		text-align: center;
		white-space: nowrap;
	}
</style>
