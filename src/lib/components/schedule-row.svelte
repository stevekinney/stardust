<script lang="ts">
	import Badge from '@lostgradient/cinder/badge';
	import Button from '@lostgradient/cinder/button';
	import type { ScheduleProjection } from '$lib/types';

	type Props = {
		schedule: ScheduleProjection;
		onPause: (schedule: ScheduleProjection) => void;
		onResume: (schedule: ScheduleProjection) => void;
		onTrigger: (schedule: ScheduleProjection) => void;
	};

	let { schedule, onPause, onResume, onTrigger }: Props = $props();

	const lastFive = $derived(
		[...schedule.fireEvents]
			.sort((a, b) => (a.actualTriggerTime < b.actualTriggerTime ? 1 : -1))
			.slice(0, 5)
	);

	const avgDurationLabel = $derived.by(() => {
		const durations = schedule.fireEvents
			.map((fire) => fire.runDurationMs)
			.filter((value): value is number => value != null && value > 0);
		if (durations.length === 0) return null;
		const averageMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
		if (averageMs < 1000) return `${Math.round(averageMs)}ms`;
		if (averageMs < 60_000) return `${Math.round(averageMs / 1000)}s`;
		return `${Math.floor(averageMs / 60_000)}m ${Math.round((averageMs % 60_000) / 1000)}s`;
	});

	const costPerFireLabel = $derived.by(() => {
		const costs = schedule.fireEvents
			.map((fire) => fire.runCostUsd)
			.filter((value): value is number => value != null);
		if (costs.length === 0) return null;
		const average = costs.reduce((sum, value) => sum + value, 0) / costs.length;
		return `$${average.toFixed(2)}/fire`;
	});

	const summary = $derived.by(() => {
		const parts = [`runs into ${schedule.targetSessionKey}`];
		if (avgDurationLabel) parts.push(`avg ${avgDurationLabel}`);
		if (costPerFireLabel) parts.push(costPerFireLabel);
		return parts.join(' · ');
	});

	const nextLabel = $derived.by(() => {
		if (schedule.status === 'paused') return 'paused';
		if (!schedule.nextRunAt) return '—';
		const ms = new Date(schedule.nextRunAt).getTime() - Date.now();
		if (ms <= 0) return 'due now';
		const hours = Math.floor(ms / 3_600_000);
		const minutes = Math.floor((ms % 3_600_000) / 60_000);
		if (hours >= 24) {
			return new Date(schedule.nextRunAt).toLocaleString([], {
				weekday: 'short',
				hour: 'numeric',
				minute: '2-digit'
			});
		}
		return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
	});

	function fireDotTitle(status: string, error: string | null): string {
		if (status === 'failed') return error ? `failed — ${error}` : 'failed';
		return 'ok';
	}
</script>

<div class="row">
	<div class="row-title">
		<span class="name">{schedule.name}</span>
		<code class="cron">{schedule.cronExpression}</code>
		{#if schedule.status === 'paused'}
			<Badge variant="warning" size="sm">paused</Badge>
		{/if}
	</div>
	<div class="row-actions">
		{#if schedule.temporalWebUrl}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
			<a class="schedule-link" href={schedule.temporalWebUrl} target="_blank" rel="noreferrer">
				schedule ↗
			</a>
		{/if}
		{#if schedule.status === 'active'}
			<Button variant="secondary" size="sm" label="Pause" onclick={() => onPause(schedule)} />
		{:else}
			<Button variant="secondary" size="sm" label="Resume" onclick={() => onResume(schedule)} />
		{/if}
		<Button variant="secondary" size="sm" label="Trigger now" onclick={() => onTrigger(schedule)} />
	</div>
	<div class="row-meta">
		<span class="last-five">
			last {lastFive.length || 0}
			{#each lastFive as fire (fire.id)}
				<span
					class="fire-dot"
					class:failed={fire.status === 'failed'}
					title={fireDotTitle(fire.status, fire.error)}
				></span>
			{/each}
		</span>
		<span class="summary">{summary}</span>
		<span class="next">next {nextLabel}</span>
	</div>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px 16px;
		padding: 14px 16px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		box-shadow: var(--cinder-shadow-sm);
	}

	.row-title {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.name {
		font-family: var(--cinder-font-mono);
		font-size: 13.5px;
		font-weight: 600;
		color: var(--cinder-text);
	}

	.cron {
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: 4px;
		padding: 1px 6px;
	}

	.row-actions {
		grid-column: 2;
		grid-row: 1 / 3;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.schedule-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 9px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
		background: var(--cinder-surface-inset);
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		text-decoration: none;
		white-space: nowrap;
	}

	.schedule-link:hover {
		color: var(--cinder-accent-text);
	}

	.row-meta {
		grid-column: 1;
		grid-row: 2;
		display: flex;
		align-items: center;
		gap: 12px;
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		min-width: 0;
	}

	.last-five {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.fire-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--cinder-success);
	}

	.fire-dot.failed {
		background: var(--cinder-danger);
	}

	.summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.next {
		color: var(--cinder-text);
		white-space: nowrap;
	}
</style>
