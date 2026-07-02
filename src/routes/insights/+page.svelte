<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Stat from '@lostgradient/cinder/stat';
	import StatGroup from '@lostgradient/cinder/stat-group';
	import type { InsightsSummary } from '$lib/types';

	let summary = $state.raw<InsightsSummary | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		try {
			const response = await fetch('/api/insights');
			if (!response.ok) throw new Error(await response.text());
			summary = (await response.json()) as InsightsSummary;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to load insights';
		} finally {
			loading = false;
		}
	}

	function formatTokens(tokens: number): string {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
		if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
		return `${tokens}`;
	}

	function formatWait(ms: number | null): string {
		if (ms == null) return '—';
		const minutes = Math.floor(ms / 60_000);
		const seconds = Math.round((ms % 60_000) / 1000);
		return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
	}

	const maxSessionCost = $derived(
		summary ? Math.max(...summary.spendBySession.map((row) => row.costUsd), 0) : 0
	);

	function openSession(sessionKey: string | null) {
		if (!sessionKey) return;
		void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`));
	}
</script>

<svelte:head>
	<title>Insights — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-head">
		<h1 class="page-title">Insights</h1>
		<span class="page-sub">
			Cost and reliability across runs — usage is recorded per activity, so the numbers are exact.
		</span>
	</div>

	{#if loading}
		<p class="state-text" aria-busy="true">Loading…</p>
	{:else if error}
		<p class="state-text" role="alert">{error}</p>
	{:else if summary}
		<StatGroup columns={4} variant="cards" label="Today at a glance">
			<Stat label="Spend today" value={`$${summary.spendTodayUsd.toFixed(2)}`} />
			<Stat label="Tokens" value={formatTokens(summary.tokensToday)} />
			<Stat label="Auto-recoveries" value={summary.retriesAutoHealed} />
			<Stat label="Human waits" value={summary.approvalsResolvedToday} />
		</StatGroup>
		<p class="stat-footnote">
			{summary.runsToday}
			{summary.runsToday === 1 ? 'run' : 'runs'} across {summary.sessionsToday}
			{summary.sessionsToday === 1 ? 'session' : 'sessions'} today · budget caps enforced in-workflow
			· median approval wait {formatWait(summary.approvalMedianWaitMs)}
		</p>

		<div class="spend-card">
			<span class="section-label">Spend by session — today</span>
			{#if summary.spendBySession.length > 0}
				{#each summary.spendBySession as row (row.title)}
					<div class="spend-row">
						<button
							type="button"
							class="spend-title"
							disabled={!row.sessionKey}
							onclick={() => openSession(row.sessionKey)}
						>
							{row.title}
						</button>
						<span class="track">
							<span
								class="fill"
								style="width: {maxSessionCost > 0 ? (row.costUsd / maxSessionCost) * 100 : 0}%"
							></span>
						</span>
						<span class="spend-cost">${row.costUsd.toFixed(2)}</span>
					</div>
				{/each}
			{:else}
				<p class="state-text">No spend recorded today.</p>
			{/if}
		</div>

		<div class="highlights">
			<div class="highlight">
				<span class="highlight-title">
					{summary.retriesAutoHealed}
					{summary.retriesAutoHealed === 1 ? 'retry' : 'retries'} auto-healed
				</span>
				<span class="highlight-body">
					Failed activities Temporal retried with backoff. Zero needed you.
				</span>
			</div>
			<div class="highlight">
				<span class="highlight-title">
					{summary.scheduleFiresToday} schedule
					{summary.scheduleFiresToday === 1 ? 'fire' : 'fires'} ran unattended
				</span>
				<span class="highlight-body">
					Native Temporal Schedules fired on time whether or not this app was open.
				</span>
			</div>
			<div class="highlight">
				<span class="highlight-title">
					{summary.approvalsResolvedToday}
					{summary.approvalsResolvedToday === 1 ? 'approval' : 'approvals'} resolved
				</span>
				<span class="highlight-body">
					Median wait {formatWait(summary.approvalMedianWaitMs)}. Runs pause durably while they
					wait.
				</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: var(--cinder-content-width);
		margin: 0 auto;
		padding: 28px 32px 48px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.page-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.page-title {
		margin: 0;
		font-size: var(--cinder-text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.page-sub {
		font-size: 12.5px;
		color: var(--cinder-text-subtle);
	}

	.state-text {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.stat-footnote {
		margin: -8px 0 0;
		font-size: 11px;
		color: var(--cinder-text-subtle);
	}

	.section-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.spend-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
	}

	.spend-row {
		display: grid;
		grid-template-columns: 220px 1fr auto;
		gap: 12px;
		align-items: center;
	}

	.spend-title {
		border: none;
		background: transparent;
		text-align: left;
		font-size: var(--cinder-text-xs);
		font-weight: 500;
		color: var(--cinder-text);
		cursor: pointer;
		padding: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.spend-title:not(:disabled):hover {
		color: var(--cinder-accent-text);
	}

	.spend-title:disabled {
		cursor: default;
	}

	.track {
		height: 8px;
		border-radius: 4px;
		background: var(--cinder-surface-inset);
		overflow: hidden;
		display: block;
	}

	.fill {
		display: block;
		height: 100%;
		background: var(--cinder-accent);
		opacity: 0.8;
		border-radius: 4px;
	}

	.spend-cost {
		font-family: var(--cinder-font-mono);
		font-size: 11.5px;
		font-weight: 600;
		color: var(--cinder-text);
		min-width: 48px;
		text-align: right;
	}

	.highlights {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}

	.highlight {
		display: grid;
		gap: 4px;
		padding: 13px 15px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
	}

	.highlight-title {
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		color: var(--cinder-text);
	}

	.highlight-body {
		font-size: 11px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}
</style>
