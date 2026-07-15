<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import Tabs from '@lostgradient/cinder/tabs';
	import TabList from '@lostgradient/cinder/tab-list';
	import Tab from '@lostgradient/cinder/tab';
	import TabPanel from '@lostgradient/cinder/tab-panel';
	import ReplayScrubber from './replay-scrubber.svelte';
	import RunPaneTimeline from './run-pane-timeline.svelte';
	import RunPaneEvents from './run-pane-events.svelte';
	import RunPaneWorkspace from './run-pane-workspace.svelte';
	import RunPaneCosts from './run-pane-costs.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import { summarizeInspectorEvent } from '$lib/run-inspector-adapters';

	type Props = {
		sessionKey: string;
		inspector: RunInspectorProjection;
		running: boolean;
		hasPendingApproval: boolean;
		/** Replay cursor (durable sequence). Null means live. Owned by the page so the conversation dims too. */
		cursor: number | null;
		onScrub: (cursor: number | null) => void;
		onInterrupt: () => void;
	};

	let { sessionKey, inspector, running, hasPendingApproval, cursor, onScrub, onInterrupt }: Props =
		$props();

	let mode = $state('timeline');

	const maxSequence = $derived(
		inspector.durabilityEvidence.latestTranscriptSequence ??
			inspector.transcript.reduce((max, event) => Math.max(max, event.sequence), 0)
	);

	const cursorSummary = $derived.by(() => {
		if (cursor === null) return null;
		const atCursor = inspector.transcript.filter((event) => event.sequence <= cursor).at(-1);
		return atCursor ? summarizeInspectorEvent(atCursor) : null;
	});

	const stateLabel = $derived(
		running
			? 'streaming'
			: hasPendingApproval
				? 'paused on durable wait'
				: (inspector.run.status ?? 'idle')
	);

	const stateDot = $derived(running ? 'accent' : hasPendingApproval ? 'warning' : 'neutral');

	const budgetLabel = $derived.by(() => {
		const spend = inspector.run.usage?.estimatedCostUsd;
		const max = inspector.run.budget?.maxEstimatedCostUsd;
		if (spend == null || max == null) return '—';
		return `$${spend.toFixed(2)} / $${max.toFixed(2)}`;
	});

	const modeHints: Record<string, string> = {
		timeline: 'steps map to activities',
		events: 'raw workflow history',
		workspace: 'files + snapshots',
		costs: 'exact, per activity'
	};
</script>

<aside class="run-pane" aria-label="Run">
	<div class="identity">
		<div class="identity-row">
			<span class="identity-label">This turn</span>
			<code class="identity-wf">{inspector.run.workflowId}</code>
			<span class="spacer"></span>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
			<a class="history-link" href={inspector.temporalWebUrl} target="_blank" rel="noreferrer">
				history ↗
			</a>
		</div>
		<div class="identity-meta">
			<span>queue <span class="strong">{inspector.taskQueue}</span></span>
			<span>budget <span class="strong">{budgetLabel}</span></span>
			<span class="spacer"></span>
			<span class="state">
				<StatusDot status={stateDot} label={stateLabel} showLabel={false} size="sm" />
				{stateLabel}
			</span>
		</div>
	</div>

	{#if maxSequence > 0}
		<ReplayScrubber {maxSequence} {cursor} {onScrub} {cursorSummary} />
	{/if}

	<Tabs bind:value={mode} fill class="run-pane-fill">
		<div class="mode-bar">
			<TabList label="Run inspector view">
				<Tab value="timeline">Timeline</Tab>
				<Tab value="events">Events</Tab>
				<Tab value="workspace">Workspace</Tab>
				<Tab value="costs">Costs</Tab>
			</TabList>
			<span class="spacer"></span>
			<span class="mode-hint">{modeHints[mode] ?? ''}</span>
		</div>
		<div class="mode-body">
			<TabPanel value="timeline">
				<RunPaneTimeline {inspector} {running} {hasPendingApproval} />
			</TabPanel>
			<TabPanel value="events">
				<RunPaneEvents {inspector} {running} {cursor} />
			</TabPanel>
			<TabPanel value="workspace">
				<RunPaneWorkspace {sessionKey} />
			</TabPanel>
			<TabPanel value="costs">
				<RunPaneCosts {inspector} />
			</TabPanel>
		</div>
	</Tabs>

	<div class="status-bar">
		{#if running}
			<StatusDot connectionState="connected" label="Streaming" showLabel={false} size="sm" />
			<span class="status-text">Streaming live · steer or interrupt anytime</span>
			<span class="spacer"></span>
			<Button variant="danger" size="sm" label="Interrupt" onclick={onInterrupt} />
		{:else}
			<StatusDot status="neutral" label="Idle" showLabel={false} size="sm" />
			<span class="status-text">Idle</span>
		{/if}
	</div>
</aside>

<style>
	.run-pane {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.spacer {
		flex: 1;
	}

	.identity {
		flex: none;
		padding: 12px 16px 10px;
		border-bottom: 1px solid var(--cinder-border-muted);
		display: grid;
		gap: 8px;
	}

	.identity-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.identity-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.identity-wf {
		font-family: var(--cinder-font-mono);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--cinder-text);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
		padding: 2px 7px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.history-link {
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--cinder-accent-text);
		text-decoration: none;
		white-space: nowrap;
	}

	.history-link:hover {
		text-decoration: underline;
	}

	.identity-meta {
		display: flex;
		align-items: center;
		gap: 14px;
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.strong {
		color: var(--cinder-text);
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
	}

	.mode-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	:global(.run-pane-fill) {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.mode-hint {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-disabled);
	}

	.mode-body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.status-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--cinder-border-muted);
	}

	.status-text {
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
	}
</style>
