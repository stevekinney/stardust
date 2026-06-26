<script lang="ts">
	import Drawer from '@lostgradient/cinder/drawer';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type Props = {
		projection: RunInspectorProjection;
		onTemporalWeb?: () => void;
		/** When true, engineer-layer details are shown additively over the operator surface. */
		engineerView?: boolean;
	};

	let { projection, onTemporalWeb, engineerView = false }: Props = $props();

	const {
		run,
		transcript,
		actionMeter,
		temporalWebUrl,
		recoveryMarkers,
		timelineLanes,
		toolInvocations
	} = $derived(projection);

	const recoveryPayloads = $derived(new Set(recoveryMarkers));

	// — raw event drawer state (engineer view only) —
	let rawEventDrawerOpen = $state(false);
	let rawEventSelected = $state<RunInspectorProjection['transcript'][number] | null>(null);

	function openRawEvent(event: RunInspectorProjection['transcript'][number]) {
		rawEventSelected = event;
		rawEventDrawerOpen = true;
	}

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

	{#if engineerView}
		<div class="engineer-overlay" data-engineer-overlay>
			<h3>Engineer Details</h3>
			<dl class="eng-meta">
				<div>
					<dt>Run ID</dt>
					<dd><code>{run.id}</code></dd>
				</div>
				<div>
					<dt>Workflow ID</dt>
					<dd><code>{run.workflowId}</code></dd>
				</div>
				<div>
					<dt>Tool invocations</dt>
					<dd>{toolInvocations.length}</dd>
				</div>
				<div>
					<dt>Temporal Web</dt>
					<dd><code class="eng-url">{temporalWebUrl}</code></dd>
				</div>
			</dl>
			<p class="eng-gap-note">
				Note: task-queue routing and attempt counts are not yet present in the run projection.
			</p>
		</div>
	{/if}

	{#if timelineLanes && timelineLanes.length > 0}
		<div class="subagent-lanes" data-subagent-lanes>
			<h3>Subagent Lanes</h3>
			<ul class="lanes-list">
				{#each timelineLanes as lane (lane.id)}
					<li class="lane" data-lane-kind={lane.kind}>
						<div class="lane-header">
							<span class="lane-label">{lane.label}</span>
							<span class="lane-status" data-status={lane.status}>{lane.status}</span>
						</div>
						{#if lane.children && lane.children.length > 0}
							<ul class="subagent-list">
								{#each lane.children as child (child.id)}
									<li class="subagent-lane" data-lane-kind={child.kind}>
										<span class="lane-label">{child.label}</span>
										<span class="lane-status" data-status={child.status}>{child.status}</span>
										{#if child.budget}
											<span class="lane-budget">
												{child.budget.inputTokens}↑ {child.budget.outputTokens}↓
											</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

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
						{#if engineerView}
							<button
								type="button"
								class="raw-event-btn"
								data-raw-event
								onclick={() => openRawEvent(event)}
							>
								Raw event ↗
							</button>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>

{#if engineerView}
	<Drawer bind:open={rawEventDrawerOpen} title="Raw Event" side="right" size="lg">
		{#if rawEventSelected}
			<div class="raw-event-content">
				<dl class="raw-event-meta">
					<div>
						<dt>ID</dt>
						<dd><code>{rawEventSelected.id}</code></dd>
					</div>
					<div>
						<dt>Kind</dt>
						<dd>{rawEventSelected.kind}</dd>
					</div>
					<div>
						<dt>Sequence</dt>
						<dd>#{rawEventSelected.sequence}</dd>
					</div>
					<div>
						<dt>Created at</dt>
						<dd>{rawEventSelected.createdAt}</dd>
					</div>
				</dl>
				<pre class="raw-payload">{JSON.stringify(rawEventSelected.payload, null, 2)}</pre>
			</div>
		{/if}
	</Drawer>
{/if}

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

	.subagent-lanes {
		border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
		padding-top: 0.75rem;
	}

	.lanes-list,
	.subagent-list {
		display: grid;
		gap: 0.4rem;
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
	}

	.lane {
		border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		background: Canvas;
	}

	.subagent-lane {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		padding: 0.35rem 0.6rem;
		border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, CanvasText 3%, Canvas);
		font-size: 0.85rem;
	}

	.lane-header {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.35rem;
	}

	.lane-label {
		flex: 1;
		font-weight: 600;
		font-size: 0.85rem;
	}

	.lane-status {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
		background: color-mix(in srgb, CanvasText 8%, transparent);
	}

	.lane-status[data-status='complete'] {
		background: #e6f3ed;
		color: #17603a;
	}

	.lane-status[data-status='failed'] {
		background: #fff1f1;
		color: #7b1d1d;
	}

	.lane-status[data-status='running'] {
		background: #eff6ff;
		color: #1d4ed8;
	}

	.lane-budget {
		color: color-mix(in srgb, CanvasText 50%, transparent);
		font-size: 0.72rem;
		font-family: ui-monospace, monospace;
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

	/* — engineer overlay — */
	.engineer-overlay {
		border-top: 2px solid #7c3aed;
		padding-top: 0.75rem;
		background: color-mix(in srgb, #7c3aed 4%, Canvas);
		border-radius: 4px;
		padding: 0.75rem;
	}

	.eng-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.5rem;
		margin: 0.5rem 0 0;
	}

	.eng-meta dt {
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.eng-meta dd {
		margin: 0;
		font-size: 0.85rem;
	}

	.eng-url {
		word-break: break-all;
		font-size: 0.72rem;
	}

	.eng-gap-note {
		margin: 0.5rem 0 0;
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.75rem;
		font-style: italic;
	}

	.raw-event-btn {
		margin-top: 0.35rem;
		padding: 0.1rem 0.4rem;
		border: 1px solid #7c3aed;
		border-radius: 4px;
		color: #7c3aed;
		font-size: 0.7rem;
		font-weight: 600;
		background: transparent;
		cursor: pointer;
	}

	.raw-event-btn:hover {
		background: color-mix(in srgb, #7c3aed 8%, transparent);
	}

	.raw-event-content {
		display: grid;
		gap: 1rem;
		padding: 1rem;
	}

	.raw-event-meta {
		display: grid;
		gap: 0.5rem;
		margin: 0;
	}

	.raw-event-meta dt {
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.raw-event-meta dd {
		margin: 0;
		font-size: 0.85rem;
	}

	.raw-payload {
		overflow: auto;
		padding: 0.75rem;
		border-radius: 4px;
		background: color-mix(in srgb, CanvasText 5%, Canvas);
		font-size: 0.75rem;
		line-height: 1.5;
	}
</style>
