<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import DurabilityRibbon from './durability-ribbon.svelte';
	import { viewMode } from '$lib/view-mode.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type Props = {
		projection: RunInspectorProjection | null;
	};

	let { projection }: Props = $props();

	const recoveryConcepts = $derived(
		projection?.temporalConcepts.filter((concept) =>
			['retry', 'heartbeat', 'workflow', 'activity'].includes(concept.primitive)
		) ?? []
	);

	function openTemporalWeb() {
		if (projection?.temporalWebUrl) {
			window.open(projection.temporalWebUrl, '_blank', 'noreferrer');
		}
	}
</script>

<div class="recovery-view">
	<section class="banner-section" aria-labelledby="recovery-heading">
		<div class="recovery-card">
			<svg
				class="banner-icon"
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<path d="m4.93 4.93 4.24 4.24" />
				<path d="m14.83 9.17 4.24-4.24" />
				<path d="m14.83 14.83 4.24 4.24" />
				<path d="m9.17 14.83-4.24 4.24" />
				<circle cx="12" cy="12" r="4" />
			</svg>
			<div class="banner-body">
				<h2 id="recovery-heading" class="banner-heading">Recovery evidence</h2>
				<p class="banner-description">
					This panel only shows durable evidence from Temporal history, transcript events, sandbox
					commands, or SQLite ledgers.
				</p>
				{#if projection && viewMode.isEngineer}
					<div class="banner-chips">
						<span class="banner-chip">{projection.run.workflowId}</span>
						{#if projection.run.temporalRunId}
							<span class="banner-chip">Temporal run {projection.run.temporalRunId}</span>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</section>

	<DurabilityRibbon evidence={projection?.durabilityEvidence ?? null} />

	<section class="body-columns">
		<div class="timeline-pane">
			<div class="section-label">Durable recovery trail</div>
			{#if recoveryConcepts.length === 0}
				<p class="empty">Recovery evidence is not available for this run.</p>
			{:else}
				<ol class="timeline" aria-label="Recovery evidence trail">
					{#each recoveryConcepts as concept (concept.id)}
						<li class="timeline-item">
							<span class="tl-dot" data-primitive={concept.primitive}></span>
							<div>
								<div class="tl-title">{concept.label}</div>
								<div class="tl-meta">{concept.summary}</div>
								<div class="tl-evidence">{concept.evidence}</div>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</div>

		<aside class="sidebar-pane" aria-label="Recovery proof">
			<div>
				<div class="section-label">Workflow</div>
				<dl class="proof-list">
					<div>
						<dt>Workflow ID</dt>
						<dd>{projection?.run.workflowId ?? 'not available'}</dd>
					</div>
					<div>
						<dt>Temporal run ID</dt>
						<dd>{projection?.run.temporalRunId ?? 'not available'}</dd>
					</div>
				</dl>
			</div>

			<div class="prove-card">
				<div class="prove-title">Presenter script</div>
				<div class="prove-code">$ bun run demo:crash</div>
				<p class="prove-description">
					Runs the crash demonstration and verifies the resulting inspector evidence.
				</p>
				<Button
					variant="secondary"
					size="sm"
					fullWidth
					disabled={!projection?.temporalWebUrl}
					onclick={openTemporalWeb}
				>
					Open in Temporal Web
				</Button>
			</div>
		</aside>
	</section>
</div>

<style>
	.recovery-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow: hidden;
	}

	.banner-section {
		flex: none;
		padding: 18px 22px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.recovery-card {
		display: flex;
		gap: 14px;
		align-items: flex-start;
		border: 1px solid var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
		border-radius: 8px;
		padding: 15px 17px;
	}

	.banner-icon,
	.banner-heading {
		color: var(--cinder-color-success-fg);
	}

	.banner-body {
		flex: 1;
		min-width: 0;
	}

	.banner-heading {
		font: 650 16px system-ui;
		margin: 0;
	}

	.banner-description {
		font: 400 13px / 1.55 system-ui;
		color: var(--cinder-color-success-fg);
		opacity: 0.92;
		margin: 4px 0 0;
		max-width: 80ch;
	}

	.banner-chips {
		display: flex;
		gap: 7px;
		flex-wrap: wrap;
		margin-top: 11px;
	}

	.banner-chip {
		font: 500 11px system-ui;
		color: var(--cinder-color-success-fg);
		background: transparent;
		border: 1px solid var(--cinder-color-success-border);
		border-radius: var(--cinder-radius-sm);
		padding: 3px 8px;
		overflow-wrap: anywhere;
	}

	.body-columns {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.timeline-pane {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 22px 24px;
	}

	.section-label {
		font: 600 10px system-ui;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
		margin-bottom: 16px;
	}

	.empty {
		margin: 0;
		color: var(--cinder-text-subtle);
		font-size: 0.9rem;
	}

	.timeline {
		position: relative;
		display: grid;
		gap: 14px;
		margin: 0;
		padding: 0 0 0 26px;
		list-style: none;
	}

	.timeline::before {
		content: '';
		position: absolute;
		left: 6px;
		top: 6px;
		bottom: 6px;
		width: 2px;
		background: var(--cinder-border);
	}

	.timeline-item {
		position: relative;
	}

	.tl-dot {
		position: absolute;
		left: -26px;
		top: 2px;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: var(--cinder-accent);
	}

	.tl-dot[data-primitive='heartbeat'] {
		background: var(--cinder-success);
	}

	.tl-dot[data-primitive='retry'] {
		background: var(--cinder-warning);
	}

	.tl-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.tl-meta,
	.tl-evidence {
		font: 400 11px / 1.45 system-ui;
		color: var(--cinder-text-subtle);
		margin-top: 2px;
	}

	.tl-evidence {
		font-family: var(--cinder-font-mono);
		overflow-wrap: anywhere;
	}

	.sidebar-pane {
		width: 332px;
		flex: none;
		border-left: 1px solid var(--cinder-border);
		overflow: auto;
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		background: var(--cinder-surface);
	}

	.proof-list {
		display: grid;
		gap: 8px;
		margin: 0;
	}

	.proof-list div {
		display: grid;
		gap: 3px;
	}

	.proof-list dt {
		font: 600 10px system-ui;
		color: var(--cinder-text-subtle);
		text-transform: uppercase;
	}

	.proof-list dd {
		margin: 0;
		font: 500 11px var(--cinder-font-mono);
		color: var(--cinder-text);
		overflow-wrap: anywhere;
	}

	.prove-card {
		border: 1px solid var(--cinder-border);
		border-radius: 8px;
		padding: 13px;
		background: var(--cinder-surface-inset);
	}

	.prove-title {
		font: 650 13px system-ui;
		color: var(--cinder-text);
	}

	.prove-code {
		margin-top: 8px;
		border-radius: 6px;
		border: 1px solid var(--cinder-border-muted);
		padding: 8px;
		background: var(--cinder-surface);
		font: 500 11px var(--cinder-font-mono);
	}

	.prove-description {
		font: 400 12px / 1.45 system-ui;
		color: var(--cinder-text-subtle);
	}

	@media (max-width: 840px) {
		.body-columns {
			flex-direction: column;
		}

		.sidebar-pane {
			width: auto;
			border-left: 0;
			border-top: 1px solid var(--cinder-border);
		}
	}
</style>
