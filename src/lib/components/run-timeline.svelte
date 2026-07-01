<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Drawer from '@lostgradient/cinder/drawer';
	import { PayloadInspector } from '@lostgradient/cinder/payload-inspector';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type ToolCallPayload = {
		text?: string;
		calls: Array<{ id: string; name: string; input: unknown }>;
	};

	type ToolResultPayload = {
		callId: string;
		content: unknown;
		isError: boolean;
	};

	type JsonToken = {
		id: string;
		kind: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation' | 'plain';
		value: string;
	};

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
		taskQueues,
		temporalConcepts,
		durabilityEvidence,
		recoveryMarkers,
		timelineLanes,
		capabilityEvidence,
		toolInvocations,
		approvalRequests
	} = $derived(projection);

	const recoveryPayloads = $derived(new Set(recoveryMarkers));

	// — step selection state —
	let selectedStep = $state<RunInspectorProjection['transcript'][number] | null>(null);

	// — raw event drawer state (engineer view only) —
	let rawEventDrawerOpen = $state(false);
	let rawEventSelected = $state<RunInspectorProjection['transcript'][number] | null>(null);

	function toggleStep(event: RunInspectorProjection['transcript'][number]) {
		selectedStep = selectedStep?.id === event.id ? null : event;
	}

	function openRawEvent(event: RunInspectorProjection['transcript'][number]) {
		rawEventSelected = event;
		rawEventDrawerOpen = true;
	}

	function kindLabel(kind: string): string {
		return kind.replace(/_/g, ' ');
	}

	function metricLabel(label: string): string {
		return label
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/^./, (character) => character.toUpperCase());
	}

	function isFlatPrimitiveObject(value: unknown): value is Record<string, unknown> {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
		return Object.values(value).every((item) => item === null || typeof item !== 'object');
	}

	function formatStepPayload(value: unknown): string {
		if (typeof value === 'string') return value;
		return JSON.stringify(value, null, isFlatPrimitiveObject(value) ? 0 : 2);
	}

	function highlightedStepPayload(value: unknown): JsonToken[] {
		const formatted = formatStepPayload(value);
		const tokenPattern =
			/("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\bnull\b|([{}[\]:,])|(\s+)|([^\s{}[\]:,]+)/g;
		return [...formatted.matchAll(tokenPattern)].map((match) => {
			const start = match.index ?? 0;
			const value = match[0];
			let kind: JsonToken['kind'] = 'plain';
			if (match[1]) kind = 'key';
			else if (match[2]) kind = 'string';
			else if (match[3]) kind = 'number';
			else if (match[4]) kind = 'boolean';
			else if (match[5]) kind = 'null';
			else if (match[6]) kind = 'punctuation';
			return { id: `${start}-${kind}`, kind, value };
		});
	}

	function isRecoveryMarker(event: RunInspectorProjection['transcript'][number]): boolean {
		const raw = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
		return event.kind === 'lifecycle' && recoveryPayloads.has(raw);
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
		if (run.status === 'running') return 'running';
		return 'none';
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

	function primitiveForStep(kind: string): string {
		const primitives: Record<string, string> = {
			user_message: 'Workflow input',
			assistant_message: 'Activity result',
			tool_call: 'Activity scheduled',
			tool_result: 'Activity completed',
			approval_request: 'Update requested',
			approval_resolution: 'Update completed',
			lifecycle: 'Workflow event'
		};
		return primitives[kind] ?? 'Workflow event';
	}

	function isToolCallPayload(value: unknown): value is ToolCallPayload {
		return (
			value !== null &&
			typeof value === 'object' &&
			'calls' in value &&
			Array.isArray((value as Record<string, unknown>).calls)
		);
	}

	function isToolResultPayload(value: unknown): value is ToolResultPayload {
		return (
			value !== null &&
			typeof value === 'object' &&
			'callId' in value &&
			typeof (value as Record<string, unknown>).callId === 'string'
		);
	}

	/** The activity/tool name for the selected step, used in PayloadInspector meta. */
	const selectedStepSource = $derived.by(() => {
		if (!selectedStep) return undefined;
		if (selectedStep.kind === 'tool_call' && isToolCallPayload(selectedStep.payload)) {
			return selectedStep.payload.calls[0]?.name ?? selectedStep.kind;
		}
		return selectedStep.kind;
	});

	/** The activity input payload for the selected step. */
	const selectedStepInput = $derived.by(() => {
		if (!selectedStep) return undefined;
		if (selectedStep.kind === 'tool_call' && isToolCallPayload(selectedStep.payload)) {
			const firstCall = selectedStep.payload.calls[0];
			return firstCall ? firstCall.input : selectedStep.payload;
		}
		return selectedStep.payload;
	});

	/** The activity result payload for the selected step (tool_call only). */
	const selectedStepResult = $derived.by(() => {
		if (!selectedStep || selectedStep.kind !== 'tool_call') return undefined;
		const payload = selectedStep.payload;
		if (!isToolCallPayload(payload) || payload.calls.length === 0) return undefined;
		const callId = payload.calls[0]?.id;
		if (!callId) return undefined;
		const resultEvent = transcript.find(
			(e) =>
				e.kind === 'tool_result' && isToolResultPayload(e.payload) && e.payload.callId === callId
		);
		if (!resultEvent) return undefined;
		return isToolResultPayload(resultEvent.payload) ? resultEvent.payload.content : undefined;
	});

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
			<span class="btn-inner">
				<!-- lucide external-link -->
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
					<polyline points="15 3 21 3 21 9" />
					<line x1="10" y1="14" x2="21" y2="3" />
				</svg>
				Open in Temporal Web
			</span>
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

	<section class="temporal-concepts" aria-labelledby="temporal-concepts-heading">
		<div class="concept-header">
			<h3 id="temporal-concepts-heading">Temporal Concepts</h3>
		</div>
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

	<!-- Raw <details> preserved: Cinder Collapsible renders an <aside> and changes
	     focus/toggle behavior. The action-meter uses <details open> which Collapsible
	     does not support as a stable prop. No upstream issue filed — raw <details> is
	     correct here: this is a simple expand/collapse for a <dl>, not an interactive card. -->
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
			<dl class="eng-meta">
				<div data-task-queue>
					<dt>Task Queue</dt>
					<dd><code>{taskQueue}</code></dd>
				</div>
				<div>
					<dt>Tool invocations</dt>
					<dd>{toolInvocations.length}</dd>
				</div>
				<div class="eng-link-row" data-temporal-workflow-link>
					<dt>Workflow</dt>
					<dd>
						<button type="button" class="workflow-link" onclick={openTemporalWeb}>
							Open workflow in Temporal Web
							<span aria-hidden="true">↗</span>
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
						<button
							class="step-header"
							class:selected={selectedStep?.id === event.id}
							type="button"
							aria-pressed={selectedStep?.id === event.id}
							onclick={() => toggleStep(event)}
						>
							{#if engineerView}
								<span
									class="eng-kind-marker"
									data-eng-kind-marker
									data-eng-kind={event.kind}
									aria-hidden="true">{kindMarker(event.kind)}</span
								>
							{/if}
							<span class="kind-badge">{kindLabel(event.kind)}</span>
							<span class="primitive-badge">{primitiveForStep(event.kind)}</span>
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
						</button>
						{#if event.payload !== null && event.payload !== undefined}
							<pre
								class="step-payload"
								data-step-payload>{#each highlightedStepPayload(event.payload) as token (token.id)}<span
										class="json-token json-token-{token.kind}">{token.value}</span
									>{/each}</pre>
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

		{#if selectedStep}
			<div class="step-detail" aria-label="Selected step detail">
				<div class="step-detail-heading">
					<!-- lucide crosshair -->
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
						class="step-detail-icon"
					>
						<circle cx="12" cy="12" r="10" />
						<line x1="22" y1="12" x2="18" y2="12" />
						<line x1="6" y1="12" x2="2" y2="12" />
						<line x1="12" y1="6" x2="12" y2="2" />
						<line x1="12" y1="22" x2="12" y2="18" />
					</svg>
					<span class="step-detail-title">Selected step</span>
					<span class="kind-badge">{kindLabel(selectedStep.kind)}</span>
					{#if selectedStep.attempts !== undefined && selectedStep.attempts > 1}
						<span class="attempt-chip"
							>attempt {selectedStep.attempts} / {selectedStep.attempts}</span
						>
					{/if}
					<button
						type="button"
						class="step-detail-close"
						aria-label="Close step detail"
						onclick={() => (selectedStep = null)}>×</button
					>
				</div>

				{#if selectedStep.attempts !== undefined && selectedStep.attempts > 1}
					<div class="retry-callout" role="note">
						<div class="retry-callout-header">
							<!-- lucide rotate-cw -->
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<polyline points="23 4 23 10 17 10" />
								<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
							</svg>
							Recovered without your help
						</div>
						<p class="retry-callout-body">
							Attempt 1 encountered an error. Temporal applied a backoff and scheduled a retry.
							Attempt {selectedStep.attempts} passed. No state was lost.
						</p>
					</div>
				{/if}

				<PayloadInspector
					value={selectedStepInput}
					meta={{ source: selectedStepSource }}
					label="Activity input"
				/>
				<PayloadInspector
					value={selectedStepResult}
					meta={{ source: selectedStepSource }}
					label="Activity result"
				/>
			</div>
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
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}

	.timeline-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.header-identity {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}

	/* Keeps the button right-aligned even when it wraps to its own line
	   below .header-identity — justify-content: space-between only aligns
	   a lone wrapped item to the line's start, not the container's end. */
	:global(.header-action) {
		margin-left: auto;
	}

	h3 {
		margin: 0 0 0.25rem;
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

	.capability-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.45rem;
	}

	.capability-pill {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'label count'
			'evidence evidence';
		gap: 0.2rem 0.45rem;
		min-width: 0;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 6px;
		padding: 0.48rem 0.55rem;
		background: var(--cinder-surface-inset);
	}

	.capability-pill[data-status='used'] {
		border-color: var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
	}

	.capability-pill[data-status='attention'] {
		border-color: var(--cinder-color-danger-border);
		background: var(--cinder-color-danger-bg);
	}

	.capability-label {
		grid-area: label;
		min-width: 0;
		color: var(--cinder-text);
		font: 700 0.72rem / 1.2 system-ui;
		overflow-wrap: anywhere;
	}

	.capability-count {
		grid-area: count;
		font: 700 0.78rem var(--cinder-font-mono);
		color: var(--cinder-text);
	}

	.capability-evidence {
		grid-area: evidence;
		color: var(--cinder-text-subtle);
		font: 500 0.68rem / 1.3 system-ui;
		overflow-wrap: anywhere;
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

	.truth-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.5rem;
		margin: 0;
	}

	.truth-strip div {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
		padding: 0.55rem 0.65rem;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
	}

	.truth-strip dt {
		color: var(--cinder-text-subtle);
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.truth-strip dd {
		margin: 0;
		font-size: 0.78rem;
		color: var(--cinder-text);
		overflow-wrap: anywhere;
	}

	.temporal-concepts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.55rem;
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
	}

	.concept-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.concept-list {
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
		align-items: start;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
		padding: 0.6rem 0.7rem;
		background: var(--cinder-surface-inset);
	}

	.concept-primitive {
		display: inline-flex;
		width: fit-content;
		border-radius: var(--cinder-radius-sm);
		border: 1px solid var(--cinder-border-muted);
		padding: 0.18rem 0.42rem;
		font: 650 0.68rem var(--cinder-font-mono);
		color: var(--cinder-accent-text);
		background: var(--cinder-surface);
	}

	.concept-body {
		display: grid;
		gap: 0.18rem;
		min-width: 0;
	}

	.concept-title {
		font: 650 0.85rem system-ui;
		color: var(--cinder-text);
	}

	.concept-summary,
	.concept-evidence {
		font: 400 0.78rem / 1.45 system-ui;
		color: var(--cinder-text-subtle);
	}

	.concept-evidence {
		font-family: var(--cinder-font-mono);
		overflow-wrap: anywhere;
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
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.5rem;
		margin: 0.5rem 0 0;
	}

	.breakdown-item {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 6px;
		padding: 0.55rem 0.65rem;
		background: var(--cinder-surface-inset);
	}

	.breakdown dt {
		color: var(--cinder-text-subtle);
		overflow-wrap: anywhere;
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1.25;
	}

	.breakdown dd {
		margin: 0;
		font-size: 1rem;
		font-weight: 700;
		font-family: var(--cinder-font-mono);
	}

	.subagent-lanes {
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
	}

	.lanes-list,
	.subagent-list {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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
		grid-template-columns: minmax(0, 1fr);
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

	.kind-badge {
		padding: 0.1rem 0.45rem;
		border-radius: 4px;
		background: var(--cinder-surface);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.primitive-badge {
		padding: 0.1rem 0.45rem;
		border-radius: 4px;
		border: 1px solid var(--cinder-border-muted);
		color: var(--cinder-text-subtle);
		font-size: 0.7rem;
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

	.json-token-key {
		color: var(--cinder-accent-text);
	}

	.json-token-string {
		color: var(--cinder-color-success-fg);
	}

	.json-token-number {
		color: var(--cinder-color-warning-fg);
	}

	.json-token-boolean,
	.json-token-null {
		color: var(--cinder-color-info-fg);
	}

	.json-token-punctuation {
		color: var(--cinder-text-muted);
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
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.75rem;
		margin: 0.5rem 0 0;
	}

	.eng-meta > div {
		min-width: 0;
	}

	.eng-meta dt {
		color: var(--cinder-text-subtle);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.eng-meta dd {
		min-width: 0;
		margin: 0;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}

	.eng-meta code {
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.eng-link-row {
		grid-column: 1 / -1;
	}

	.workflow-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--cinder-accent-text);
		font: inherit;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}

	.workflow-link:hover {
		text-decoration: underline;
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
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		padding: 1rem;
	}

	.raw-event-meta {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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

	/* — Temporal Web button inner layout — */
	.btn-inner {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	/* — step header as button — */
	.step-header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		width: 100%;
		background: transparent;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
		font: inherit;
		color: inherit;
		border-radius: 3px;
	}

	.step-header:hover {
		background: var(--cinder-surface-hover);
	}

	.step-header.selected {
		background: var(--cinder-surface-inset);
	}

	/* — step detail panel — */
	.step-detail {
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.step-detail-heading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.step-detail-icon {
		color: var(--cinder-accent-text);
		flex-shrink: 0;
	}

	.step-detail-title {
		font: 600 0.85rem system-ui;
		color: var(--cinder-text);
	}

	.attempt-chip {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: var(--cinder-surface);
		font-size: 0.72rem;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		border: 1px solid var(--cinder-border-muted);
	}

	.step-detail-close {
		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--cinder-text-subtle);
		font-size: 1rem;
		cursor: pointer;
	}

	.step-detail-close:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	/* — retry callout — */
	.retry-callout {
		border: 1px solid var(--cinder-color-warning-border);
		background: var(--cinder-color-warning-bg);
		border-radius: 9px;
		padding: 0.7rem 0.8rem;
	}

	.retry-callout-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font: 600 11.5px system-ui;
		color: var(--cinder-color-warning-fg);
	}

	.retry-callout-body {
		font: 400 11.5px/1.5 system-ui;
		color: var(--cinder-color-warning-fg);
		opacity: 0.92;
		margin: 0.35rem 0 0;
	}
</style>
