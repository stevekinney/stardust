<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import RunPaneEvents from './run-pane-events.svelte';
	import RunPaneTimeline from './run-pane-timeline.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type Props = {
		projection: RunInspectorProjection;
		onTemporalWeb?: () => void;
		engineerView?: boolean;
	};

	let { projection, onTemporalWeb, engineerView = false }: Props = $props();

	const {
		run,
		actionMeter,
		temporalWebUrl,
		taskQueue,
		taskQueues,
		temporalConcepts,
		durabilityEvidence,
		timelineLanes,
		capabilityEvidence,
		toolInvocations,
		approvalRequests
	} = $derived(projection);

	const running = $derived(run.status === 'running');
	const hasPendingApproval = $derived(
		approvalRequests.some((approval) => approval.status === 'pending')
	);

	function metricLabel(label: string): string {
		return label
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/^./, (character) => character.toUpperCase());
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleTimeString();
	}

	function formatNullable(value: string | number | null | undefined): string {
		return value == null || value === '' ? 'not available' : String(value);
	}

	function waitState(): string {
		const pending = approvalRequests.filter((approval) => approval.status === 'pending').length;
		if (pending > 0) return `${pending} approval wait${pending === 1 ? '' : 's'}`;
		if (running) return 'running';
		return 'none';
	}

	function formatDuration(startedAt: string | null, completedAt: string | null): string {
		if (!startedAt || !completedAt) return '';
		const milliseconds = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
	}

	function openTemporalWeb() {
		if (onTemporalWeb) {
			onTemporalWeb();
		} else {
			window.open(temporalWebUrl, '_blank', 'noreferrer');
		}
	}
</script>

<section class="run-timeline" aria-label="Run inspector timeline">
	<div class="timeline-header">
		<div class="header-identity">
			<p class="muted">{run.workflowId}</p>
			<div class="header-meta">
				<span class="status-badge" data-status={run.status}>{run.status}</span>
				{#if run.model}
					<span class="model-badge">model {run.model}</span>
				{/if}
			</div>
		</div>
		<Button
			variant="secondary"
			size="sm"
			class="header-action"
			data-temporal-web
			onclick={openTemporalWeb}
		>
			<span class="button-inner">Open in Temporal Web</span>
		</Button>
	</div>

	<section class="capability-strip" aria-label="Agent capabilities">
		{#each capabilityEvidence as capability (capability.id)}
			<div class="capability-pill" data-status={capability.status}>
				<span class="capability-label">{capability.label}</span>
				<span class="capability-count">{capability.count}</span>
				<span class="capability-evidence">{capability.evidence}</span>
			</div>
		{/each}
	</section>

	<dl class="truth-strip" aria-label="Run truth strip">
		<div>
			<dt>Workflow ID</dt>
			<dd><code>{run.workflowId}</code></dd>
		</div>
		<div>
			<dt>Temporal run ID</dt>
			<dd><code>{formatNullable(run.temporalRunId)}</code></dd>
		</div>
		<div>
			<dt>Run ID</dt>
			<dd><code>{run.id}</code></dd>
		</div>
		<div>
			<dt>Status</dt>
			<dd>{run.status}</dd>
		</div>
		<div>
			<dt>Task queues</dt>
			<dd>{taskQueues.join(', ')}</dd>
		</div>
		<div>
			<dt>Wait state</dt>
			<dd>{waitState()}</dd>
		</div>
		<div>
			<dt>Stream cursor</dt>
			<dd>{formatNullable(durabilityEvidence.latestStreamEventId)}</dd>
		</div>
	</dl>

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

	<section class="temporal-concepts" aria-labelledby="temporal-concepts-heading">
		<h3 id="temporal-concepts-heading">Temporal Concepts</h3>
		{#if temporalConcepts.length === 0}
			<p class="muted empty">No Temporal concept evidence recorded for this run.</p>
		{:else}
			<ul class="concept-list">
				{#each temporalConcepts as concept (concept.id)}
					<li class="concept-row" data-primitive={concept.primitive}>
						<span class="concept-primitive">{concept.primitive}</span>
						<div class="concept-body">
							<div class="concept-title">{concept.label}</div>
							<div class="concept-summary">{concept.summary}</div>
							{#if engineerView}
								<div class="concept-evidence">{concept.evidence}</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<details class="action-meter" open>
		<summary>Action Meter</summary>
		<dl class="breakdown">
			{#each Object.entries(actionMeter.breakdown) as [label, count] (label)}
				<div class="breakdown-item" data-action-meter-item>
					<dt>{metricLabel(label)}</dt>
					<dd>{count}</dd>
				</div>
			{/each}
		</dl>
	</details>

	{#if engineerView}
		<div class="engineer-overlay" data-engineer-overlay>
			<h3>Engineer Details</h3>
			<dl class="engineer-meta">
				<div data-task-queue>
					<dt>Task Queue</dt>
					<dd><code>{taskQueue}</code></dd>
				</div>
				<div>
					<dt>Tool invocations</dt>
					<dd>{toolInvocations.length}</dd>
				</div>
				<div class="engineer-link-row" data-temporal-workflow-link>
					<dt>Workflow</dt>
					<dd>
						<button type="button" class="workflow-link" onclick={openTemporalWeb}>
							Open workflow in Temporal Web
						</button>
					</dd>
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
												{child.budget.inputTokens} input / {child.budget.outputTokens} output
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

	<div class="cinder-run-surface">
		<section class="run-steps" aria-labelledby="run-steps-heading">
			<h3 id="run-steps-heading">Step Timeline</h3>
			<RunPaneTimeline inspector={projection} {running} {hasPendingApproval} />
		</section>

		<section class="run-events" aria-labelledby="run-events-heading">
			<h3 id="run-events-heading">Event Stream</h3>
			<RunPaneEvents inspector={projection} {running} cursor={null} />
		</section>
	</div>
</section>

<style>
	.run-timeline {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}

	h3,
	p {
		margin: 0;
	}

	h3 {
		font-size: 0.95rem;
	}

	.muted,
	.concept-summary,
	.concept-evidence,
	.lane-budget {
		color: var(--cinder-text-subtle);
		font-size: 0.85rem;
	}

	.timeline-header,
	.header-identity,
	.header-meta,
	.run-meta,
	.lane-header,
	.subagent-lane {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}

	.timeline-header {
		justify-content: space-between;
	}

	:global(.header-action) {
		margin-left: auto;
	}

	.status-badge,
	.model-badge,
	.lane-status {
		border-radius: 999px;
		padding: 0.18rem 0.55rem;
		background: var(--cinder-surface);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.status-badge[data-status='complete'],
	.lane-status[data-status='complete'] {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-badge[data-status='failed'],
	.lane-status[data-status='failed'] {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.status-badge[data-status='running'],
	.lane-status[data-status='running'] {
		background: var(--cinder-color-info-bg);
		color: var(--cinder-color-info-fg);
	}

	.status-badge[data-status='waiting_approval'] {
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	.model-badge,
	code {
		font-family: var(--cinder-font-mono);
	}

	.capability-strip,
	.truth-strip,
	.breakdown,
	.engineer-meta {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.5rem;
		margin: 0;
	}

	.capability-pill,
	.truth-strip div,
	.breakdown-item,
	.concept-row,
	.lane,
	.subagent-lane,
	.engineer-overlay {
		min-width: 0;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
		padding: 0.6rem 0.7rem;
		background: var(--cinder-surface-inset);
	}

	.capability-pill {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'label count'
			'evidence evidence';
		gap: 0.2rem 0.45rem;
	}

	.capability-pill[data-status='used'] {
		border-color: var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
	}

	.capability-pill[data-status='attention'] {
		border-color: var(--cinder-color-danger-border);
		background: var(--cinder-color-danger-bg);
	}

	.capability-label,
	.concept-title,
	.lane-label {
		font-weight: 700;
	}

	.capability-label {
		grid-area: label;
	}

	.capability-count {
		grid-area: count;
		font: 700 0.78rem var(--cinder-font-mono);
	}

	.capability-evidence {
		grid-area: evidence;
		color: var(--cinder-text-subtle);
		font-size: 0.75rem;
	}

	dt {
		color: var(--cinder-text-subtle);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.temporal-concepts,
	.action-meter,
	.subagent-lanes,
	.run-steps,
	.run-events {
		display: grid;
		gap: 0.55rem;
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
	}

	.concept-list,
	.lanes-list,
	.subagent-list {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.45rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.concept-row {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr);
		gap: 0.75rem;
	}

	.concept-primitive {
		width: fit-content;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 4px;
		padding: 0.18rem 0.42rem;
		color: var(--cinder-accent-text);
		font: 650 0.68rem var(--cinder-font-mono);
	}

	.breakdown {
		margin-top: 0.5rem;
	}

	.engineer-overlay {
		border-color: var(--cinder-accent);
	}

	.engineer-link-row {
		grid-column: 1 / -1;
	}

	.workflow-link {
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--cinder-accent-text);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.workflow-link:hover {
		text-decoration: underline;
	}

	.button-inner {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.cinder-run-surface {
		display: grid;
		gap: 1rem;
	}
</style>
