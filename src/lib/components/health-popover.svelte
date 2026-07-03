<script lang="ts">
	import Popover from '@lostgradient/cinder/popover';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import type { HealthSnapshot } from '$lib/types';

	let { health = null }: { health?: HealthSnapshot | null } = $props();

	let open = $state(false);

	const reachable = $derived(health?.reachable ?? true);
	const address = $derived(health?.address ?? 'localhost:7233');
	const temporalWebUrl = $derived(health?.temporalWebUrl ?? 'http://localhost:8233');
	const port = $derived(address.includes(':') ? address.slice(address.lastIndexOf(':')) : address);
	const taskQueueUrl = $derived(
		`${temporalWebUrl}/namespaces/${health?.namespace ?? 'default'}/task-queues/agent-orchestrator`
	);

	function formatSpend(usd: number | null | undefined): string {
		return usd == null ? '—' : `$${usd.toFixed(2)}`;
	}

	function formatTokens(tokens: number | null | undefined): string {
		if (tokens == null) return '—';
		return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
	}
</script>

<Popover bind:open placement="bottom-end" label="Infrastructure health" role="dialog">
	{#snippet trigger()}
		<button type="button" class="cluster" onclick={() => (open = !open)}>
			<StatusDot
				status={reachable ? 'success' : 'danger'}
				label={reachable ? 'Temporal reachable' : 'Temporal unreachable'}
				showLabel={false}
				size="sm"
			/>
			<span class="label">temporal {port}</span>
			<span class="detail">
				{#if health?.workerCount != null}
					<span class="sep">·</span>
					<span>{health.workerCount} {health.workerCount === 1 ? 'worker' : 'workers'}</span>
				{/if}
				{#if health?.spendTodayUsd != null}
					<span class="sep">·</span>
					<span>{formatSpend(health.spendTodayUsd)} today</span>
				{/if}
			</span>
		</button>
	{/snippet}

	<div class="panel">
		<div class="panel-head">
			<StatusDot
				status={reachable ? 'success' : 'danger'}
				label={reachable ? 'Everything durable' : 'Temporal unreachable'}
				showLabel={false}
				size="sm"
			/>
			<span class="panel-title">{reachable ? 'Everything durable' : 'Temporal unreachable'}</span>
			<span class="spacer"></span>
			<span class="panel-namespace">namespace {health?.namespace ?? 'default'}</span>
		</div>

		<div class="grid">
			<div class="cell">
				<span class="cell-label">Temporal server</span>
				<span class="cell-value">{address} {reachable ? '✓' : '✕'}</span>
			</div>
			<div class="cell">
				<span class="cell-label">Workers</span>
				<span class="cell-value">
					{health?.workerCount != null ? `${health.workerCount} polling` : '—'}
				</span>
			</div>
			<div class="cell">
				<span class="cell-label">Task queues</span>
				<span class="cell-value">
					{#if health && health.taskQueues.length > 0}
						{#each health.taskQueues as queue (queue.name)}
							<span class="queue">{queue.name} {queue.healthy ? '✓' : '✕'}</span>
						{/each}
					{:else}
						—
					{/if}
				</span>
			</div>
			<div class="cell">
				<span class="cell-label">Spend today</span>
				<span class="cell-value">
					{formatSpend(health?.spendTodayUsd)} · {formatTokens(health?.tokensToday)}
				</span>
			</div>
		</div>

		<p class="explainer">
			If a worker dies mid-run, another picks up from the last durable event. Close this tab freely
			— nothing here lives in the browser.
		</p>

		<div class="links">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
			<a href={temporalWebUrl} target="_blank" rel="noreferrer" class="link link-primary">
				Open Temporal Web ↗
			</a>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
			<a href={taskQueueUrl} target="_blank" rel="noreferrer" class="link">Task queue ↗</a>
		</div>
	</div>
</Popover>

<style>
	.cluster {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-inset);
		cursor: pointer;
		font-family: var(--cinder-font-mono);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.cluster:hover {
		border-color: var(--cinder-border-strong);
		color: var(--cinder-text);
	}

	.sep {
		color: var(--cinder-border-strong);
	}

	.detail {
		display: contents;
	}

	/*
	 * Matches the search trigger's collapse point in top-nav.svelte — below this
	 * width the worker/spend detail is the next thing to shed so the tab list
	 * stays readable. The status dot + port stay, since that's the one glance
	 * clue for "is Temporal reachable".
	 */
	@container cinder-navigation-bar (max-width: 80rem) {
		.detail {
			display: none;
		}
	}

	/*
	 * Phone-width nav (matches the app's ≤640px phone breakpoint): even the
	 * compact "temporal :port" label doesn't fit alongside the brand, menu
	 * toggle, search icon, and settings icon. Drop to the status dot alone —
	 * it still carries the reachable/unreachable state via its own aria-label,
	 * and tapping it opens the full detail panel.
	 */
	@container cinder-navigation-bar (max-width: 40rem) {
		.label {
			display: none;
		}

		.cluster {
			padding: 0 8px;
		}
	}

	.panel {
		width: 340px;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.panel-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.panel-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--cinder-text);
	}

	.spacer {
		flex: 1;
	}

	.panel-namespace {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.cell {
		padding: 9px 11px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		display: grid;
		gap: 2px;
	}

	.cell-label {
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--cinder-text-subtle);
	}

	.cell-value {
		font-family: var(--cinder-font-mono);
		font-size: 12px;
		font-weight: 500;
		color: var(--cinder-text);
	}

	.queue {
		display: block;
	}

	.explainer {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}

	.links {
		display: flex;
		gap: 8px;
	}

	.link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface);
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		text-decoration: none;
	}

	.link:hover {
		color: var(--cinder-text);
	}

	.link-primary {
		color: var(--cinder-accent-text);
	}

	.link-primary:hover {
		border-color: var(--cinder-accent);
		color: var(--cinder-accent-text);
	}
</style>
