<script lang="ts">
	import Button from '@lostgradient/cinder/button';
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
		taskQueue,
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

	function formatMs(ms: number): string {
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	/** Returns a compact symbol for each transcript event kind, for engineer-view markers. */
	function kindMarker(kind: string): string {
		const markers: Record<string, string> = {
			user_message: '↓',
			assistant_message: '↑',
			tool_call: '⚙',
			tool_result: '→',
			approval_request: '?',
			approval_resolution: '✓',
			lifecycle: '◎'
		};
		return markers[kind] ?? '·';
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
			<Button
				label="Temporal Web ↗"
				variant="secondary"
				size="sm"
				data-temporal-web
				onclick={() => {
					if (onTemporalWeb) {
						onTemporalWeb();
					} else {
						window.open(temporalWebUrl, '_blank', 'noreferrer');
					}
				}}
			/>
		</div>
	</div>

	{#if run.startedAt}
		<!-- Raw <dl> preserved: DescriptionList only supports plain string definitions;
		     run metadata entries require formatted timestamp/duration values not supported as snippets. -->
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

	<!-- Raw <details> preserved: Cinder Collapsible renders an <aside> and changes
	     focus/toggle behavior. The action-meter uses <details open> which Collapsible
	     does not support as a stable prop. No upstream issue filed — raw <details> is
	     correct here: this is a simple expand/collapse for a <dl>, not an interactive card. -->
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
				<div data-task-queue>
					<dt>Task Queue</dt>
					<dd><code>{taskQueue}</code></dd>
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
							{#if engineerView}
								<span
									class="eng-kind-marker"
									data-eng-kind-marker
									data-eng-kind={event.kind}
									aria-hidden="true">{kindMarker(event.kind)}</span
								>
							{/if}
							<span class="kind-badge">{kindLabel(event.kind)}</span>
							<span class="sequence">#{event.sequence}</span>
							{#if event.durationMs !== undefined}
								<span class="step-duration" data-step-duration aria-label="duration"
									>{formatMs(event.durationMs)}</span
								>
							{/if}
							{#if event.attempts !== undefined && event.attempts > 1}
								<span class="step-attempts" data-step-attempts aria-label="attempts"
									>×{event.attempts}</span
								>
							{/if}
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
							<Button
								label="Raw event ↗"
								variant="ghost"
								size="xs"
								data-raw-event
								onclick={() => openRawEvent(event)}
							/>
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
		color: var(--cinder-text-subtle);
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
		background: var(--cinder-surface);
	}

	.status-badge[data-status='complete'] {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-badge[data-status='failed'] {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.status-badge[data-status='running'] {
		background: var(--cinder-color-info-bg);
		color: var(--cinder-color-info-fg);
	}

	.status-badge[data-status='waiting_approval'] {
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	.model-badge {
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		background: var(--cinder-surface);
		font-size: 0.75rem;
		font-family: var(--cinder-font-mono);
	}

	.run-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin: 0;
	}

	.run-meta dt {
		color: var(--cinder-text-subtle);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.run-meta dd {
		margin: 0;
		font-size: 0.9rem;
	}

	.action-meter {
		border-top: 1px solid var(--cinder-border-muted);
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
		color: var(--cinder-text-subtle);
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
		border-top: 1px solid var(--cinder-border-muted);
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
		border: 1px solid var(--cinder-border-muted);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		background: var(--cinder-bg);
	}

	.subagent-lane {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		padding: 0.35rem 0.6rem;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 5px;
		background: var(--cinder-surface-inset);
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
		background: var(--cinder-surface);
	}

	.lane-status[data-status='complete'] {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.lane-status[data-status='failed'] {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.lane-status[data-status='running'] {
		background: var(--cinder-color-info-bg);
		color: var(--cinder-color-info-fg);
	}

	.lane-budget {
		color: var(--cinder-text-subtle);
		font-size: 0.72rem;
		font-family: var(--cinder-font-mono);
	}

	.step-timeline {
		border-top: 1px solid var(--cinder-border-muted);
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
		border: 1px solid var(--cinder-border-muted);
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		background: var(--cinder-bg);
	}

	.step.recovery {
		border-color: var(--cinder-accent);
		background: var(--cinder-surface);
	}

	.recovery-marker {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-bottom: 0.4rem;
		color: var(--cinder-accent);
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
		background: var(--cinder-surface);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.sequence {
		color: var(--cinder-text-subtle);
		font-size: 0.75rem;
		font-family: var(--cinder-font-mono);
	}

	.step-duration {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: var(--cinder-color-info-bg);
		color: var(--cinder-color-info-fg);
		font-size: 0.72rem;
		font-family: var(--cinder-font-mono);
		font-weight: 600;
	}

	.step-attempts {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
		font-size: 0.72rem;
		font-family: var(--cinder-font-mono);
		font-weight: 700;
	}

	.timestamp {
		margin-left: auto;
		color: var(--cinder-text-subtle);
		font-size: 0.75rem;
	}

	.step-payload {
		overflow-x: auto;
		max-height: 8rem;
		margin: 0.4rem 0 0;
		border-radius: 4px;
		padding: 0.5rem;
		background: var(--cinder-surface-inset);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.empty {
		margin-top: 0.5rem;
	}

	/* — engineer overlay — */
	.engineer-overlay {
		border-top: 2px solid var(--cinder-accent);
		padding-top: 0.75rem;
		background: var(--cinder-surface);
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
		color: var(--cinder-text-subtle);
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

	/* — per-kind engineer markers — */
	.eng-kind-marker {
		font-size: 0.8rem;
		font-family: var(--cinder-font-mono);
		font-weight: 700;
		color: var(--cinder-accent);
	}

	.eng-kind-marker[data-eng-kind='user_message'] {
		color: var(--cinder-color-info-fg);
	}

	.eng-kind-marker[data-eng-kind='assistant_message'] {
		color: var(--cinder-color-success-fg);
	}

	.eng-kind-marker[data-eng-kind='tool_call'] {
		color: var(--cinder-color-warning-fg);
	}

	.eng-kind-marker[data-eng-kind='tool_result'] {
		color: var(--cinder-accent);
	}

	.eng-kind-marker[data-eng-kind='approval_request'] {
		color: var(--cinder-color-danger-fg);
	}

	.eng-kind-marker[data-eng-kind='approval_resolution'] {
		color: var(--cinder-color-success-fg);
	}

	.eng-kind-marker[data-eng-kind='lifecycle'] {
		color: var(--cinder-text-disabled);
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
		color: var(--cinder-text-subtle);
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
		background: var(--cinder-surface-inset);
		font-size: 0.75rem;
		line-height: 1.5;
	}
</style>
