<script lang="ts">
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type Props = {
		projection: RunInspectorProjection;
		onTemporalWeb?: () => void;
	};

	let { projection, onTemporalWeb }: Props = $props();

	const { run, transcript, actionMeter, temporalWebUrl, recoveryMarkers } = $derived(projection);

	const recoveryPayloads = $derived(new Set(recoveryMarkers));

	function kindLabel(kind: string): string {
		return kind.replace(/_/g, ' ');
	}

	function isRecoveryMarker(event: RunInspectorProjection['transcript'][number]): boolean {
		const raw = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
		return event.kind === 'lifecycle' && recoveryPayloads.has(raw);
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleTimeString();
	}

	function formatDuration(startedAt: string | null, completedAt: string | null): string {
		if (!startedAt || !completedAt) return '';
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}
</script>

<section class="run-timeline" aria-labelledby="run-timeline-heading">
	<div class="timeline-header">
		<div>
			<h2 id="run-timeline-heading">Run Inspector</h2>
			<p class="muted">{run.workflowId}</p>
		</div>
		<div class="header-meta">
			<span class="status-badge" data-status={run.status}>{run.status}</span>
			{#if run.model}
				<span class="model-badge">{run.model}</span>
			{/if}
			<button
				type="button"
				class="temporal-link"
				data-temporal-web
				onclick={() => {
					if (onTemporalWeb) {
						onTemporalWeb();
					} else {
						window.open(temporalWebUrl, '_blank', 'noreferrer');
					}
				}}
			>
				Temporal Web ↗
			</button>
		</div>
	</div>

	{#if run.startedAt}
		<dl class="run-meta">
			<div>
				<dt>Started</dt>
				<dd>{formatTimestamp(run.startedAt)}</dd>
			</div>
			{#if run.completedAt}
				<div>
					<dt>Duration</dt>
					<dd>{formatDuration(run.startedAt, run.completedAt)}</dd>
				</div>
			{/if}
			<div>
				<dt>Actions</dt>
				<dd>{actionMeter.total}</dd>
			</div>
		</dl>
	{/if}

	<details class="action-meter" open>
		<summary>Action Meter</summary>
		<dl class="breakdown">
			{#each Object.entries(actionMeter.breakdown) as [label, count] (label)}
				<div>
					<dt>{label}</dt>
					<dd>{count}</dd>
				</div>
			{/each}
		</dl>
	</details>

	<div class="step-timeline">
		<h3>Step Timeline</h3>
		{#if transcript.length === 0}
			<p class="muted empty">No transcript events recorded for this run.</p>
		{:else}
			<ol class="steps" aria-label="Run steps">
				{#each transcript as event (event.id)}
					{@const recovery = isRecoveryMarker(event)}
					<li class="step" class:recovery data-kind={event.kind} aria-label={kindLabel(event.kind)}>
						{#if recovery}
							<div class="recovery-marker" data-recovery-marker>
								<span class="recovery-icon" aria-hidden="true">↺</span>
								<strong class="recovery-label">Recovery marker</strong>
							</div>
						{/if}
						<div class="step-header">
							<span class="kind-badge">{kindLabel(event.kind)}</span>
							<span class="sequence">#{event.sequence}</span>
							<time class="timestamp" datetime={event.createdAt}>
								{formatTimestamp(event.createdAt)}
							</time>
						</div>
						{#if event.payload !== null && event.payload !== undefined}
							<pre class="step-payload">{typeof event.payload === 'string'
									? event.payload
									: JSON.stringify(event.payload, null, 2)}</pre>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>

<style>
	.run-timeline {
		display: grid;
		gap: 1rem;
	}

	.timeline-header {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	h2,
	h3 {
		margin: 0 0 0.25rem;
	}

	h3 {
		font-size: 0.95rem;
	}

	.muted {
		margin: 0;
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.85rem;
	}

	.header-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.status-badge {
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: capitalize;
		background: color-mix(in srgb, CanvasText 10%, transparent);
	}

	.status-badge[data-status='complete'] {
		background: #e6f3ed;
		color: #17603a;
	}

	.status-badge[data-status='failed'] {
		background: #fff1f1;
		color: #7b1d1d;
	}

	.status-badge[data-status='running'] {
		background: #eff6ff;
		color: #1d4ed8;
	}

	.status-badge[data-status='waiting_approval'] {
		background: #fef9c3;
		color: #7a5b00;
	}

	.model-badge {
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		background: color-mix(in srgb, CanvasText 7%, transparent);
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
	}

	.temporal-link {
		padding: 0.2rem 0.6rem;
		border: 1px solid currentcolor;
		border-radius: 6px;
		color: #174c77;
		font-size: 0.8rem;
		font-weight: 700;
		text-decoration: none;
		white-space: nowrap;
	}

	.run-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin: 0;
	}

	.run-meta dt {
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.run-meta dd {
		margin: 0;
		font-size: 0.9rem;
	}

	.action-meter {
		border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
		padding-top: 0.75rem;
	}

	.action-meter summary {
		cursor: pointer;
		font-weight: 700;
		font-size: 0.9rem;
	}

	.breakdown {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.5rem 0 0;
	}

	.breakdown dt {
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.breakdown dd {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 700;
	}

	.step-timeline {
		border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
		padding-top: 0.75rem;
	}

	.steps {
		display: grid;
		gap: 0.5rem;
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
	}

	.step {
		border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		background: Canvas;
	}

	.step.recovery {
		border-color: #6d28d9;
		background: #f5f3ff;
	}

	.recovery-marker {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-bottom: 0.4rem;
		color: #6d28d9;
		font-size: 0.8rem;
	}

	.recovery-icon {
		font-size: 1rem;
	}

	.recovery-label {
		font-weight: 700;
	}

	.step-header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.kind-badge {
		padding: 0.1rem 0.45rem;
		border-radius: 4px;
		background: color-mix(in srgb, CanvasText 8%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.sequence {
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
	}

	.timestamp {
		margin-left: auto;
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.75rem;
	}

	.step-payload {
		overflow-x: auto;
		max-height: 8rem;
		margin: 0.4rem 0 0;
		border-radius: 4px;
		padding: 0.5rem;
		background: color-mix(in srgb, CanvasText 5%, Canvas);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.empty {
		margin-top: 0.5rem;
	}
</style>
