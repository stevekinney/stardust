<script lang="ts">
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	let { inspector }: { inspector: RunInspectorProjection } = $props();

	const usage = $derived(inspector.run.usage);
	const budget = $derived(inspector.run.budget);
	const spend = $derived(usage?.estimatedCostUsd ?? null);
	const maxSpend = $derived(budget?.maxEstimatedCostUsd ?? null);
	const percent = $derived(
		spend != null && maxSpend != null && maxSpend > 0 ? Math.min(100, (spend / maxSpend) * 100) : 0
	);
	const tokensUsed = $derived(usage ? usage.inputTokens + usage.outputTokens : null);
	const tokensMax = $derived(budget?.maxTokens ?? null);
	const modelCalls = $derived(
		inspector.transcript.filter((event) => event.kind === 'assistant_message').length
	);

	/** Subagent lanes with recorded budgets — the only per-step cost granularity the server records. */
	const laneRows = $derived.by(() => {
		const lanes = (inspector.timelineLanes ?? []).flatMap((lane) =>
			lane.kind === 'parent' ? (lane.children ?? []) : [lane]
		);
		const withBudget = lanes.filter((lane) => lane.budget);
		const maxCost = Math.max(...withBudget.map((lane) => lane.budget?.estimatedCostUsd ?? 0), 0);
		return withBudget.map((lane) => ({
			id: lane.id,
			label: lane.label,
			tokens: lane.budget ? lane.budget.inputTokens + lane.budget.outputTokens : 0,
			cost: lane.budget?.estimatedCostUsd ?? 0,
			percent: maxCost > 0 ? ((lane.budget?.estimatedCostUsd ?? 0) / maxCost) * 100 : 0
		}));
	});

	function formatCompact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return `${n}`;
	}
</script>

<div class="costs">
	<div class="budget">
		<div class="budget-head">
			<span class="budget-label">Budget — enforced in-workflow</span>
			<span class="budget-value">
				{#if spend != null && maxSpend != null}
					${spend.toFixed(2)} / ${maxSpend.toFixed(2)}
				{:else}
					not available
				{/if}
			</span>
		</div>
		{#if spend != null && maxSpend != null}
			<div class="track"><div class="fill" style="width: {percent}%"></div></div>
			<span class="budget-meta">
				{tokensUsed == null ? '—' : formatCompact(tokensUsed)} / {tokensMax == null
					? '—'
					: formatCompact(tokensMax)} tokens · {modelCalls} model calls
			</span>
		{/if}
	</div>

	<div class="by-step">
		<span class="section-label">By delegate</span>
		{#if laneRows.length > 0}
			{#each laneRows as row (row.id)}
				<div class="cost-row">
					<span class="cost-label">{row.label}</span>
					<span class="track cost-track"
						><span class="fill" style="width: {row.percent}%"></span></span
					>
					<span class="cost-tokens">{formatCompact(row.tokens)} tok</span>
					<span class="cost-usd">${row.cost.toFixed(2)}</span>
				</div>
			{/each}
		{:else}
			<p class="empty">Per-step costs are recorded per delegate; this run has no delegate lanes.</p>
		{/if}
	</div>

	<p class="footnote">
		At the cap the workflow does not die — it pauses on a durable wait and asks you to raise the
		budget or stop.
	</p>
</div>

<style>
	.costs {
		display: grid;
		gap: 14px;
	}

	.budget {
		display: grid;
		gap: 6px;
	}

	.budget-head {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		font-weight: 600;
	}

	.budget-label {
		color: var(--cinder-text-subtle);
	}

	.budget-value {
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text);
	}

	.track {
		height: 6px;
		border-radius: 3px;
		background: var(--cinder-surface-inset);
		overflow: hidden;
		display: block;
	}

	.fill {
		display: block;
		height: 100%;
		background: var(--cinder-accent);
		border-radius: 3px;
	}

	.budget-meta {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.by-step {
		display: grid;
		gap: 6px;
	}

	.section-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.cost-row {
		display: grid;
		grid-template-columns: 140px 1fr auto auto;
		gap: 10px;
		align-items: center;
		font-family: var(--cinder-font-mono);
		font-size: 11.5px;
		font-weight: 500;
	}

	.cost-label {
		color: var(--cinder-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cost-track .fill {
		opacity: 0.75;
	}

	.cost-tokens {
		color: var(--cinder-text-subtle);
	}

	.cost-usd {
		color: var(--cinder-text);
		min-width: 44px;
		text-align: right;
	}

	.empty {
		margin: 0;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
	}

	.footnote {
		margin: 0;
		font-size: 11px;
		line-height: 1.55;
		color: var(--cinder-text-subtle);
	}
</style>
