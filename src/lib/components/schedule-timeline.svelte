<script lang="ts">
	import type { ScheduleProjection } from '$lib/types';

	let { schedules }: { schedules: ScheduleProjection[] } = $props();

	type Fire = {
		id: string;
		name: string;
		time: string;
		positionPercent: number;
		fired: boolean;
	};

	const WINDOW_MS = 24 * 60 * 60 * 1000;
	/** The "now" marker sits a quarter in so recent fires stay visible. */
	const NOW_POSITION_PERCENT = 25;

	function formatClock(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	/** Fires in the window from 6h ago to 18h ahead, mapped onto the track. */
	const fires = $derived.by((): Fire[] => {
		const now = Date.now();
		const windowStart = now - WINDOW_MS * (NOW_POSITION_PERCENT / 100);
		const items: Fire[] = [];

		for (const schedule of schedules) {
			for (const fire of schedule.fireEvents) {
				const at = new Date(fire.actualTriggerTime).getTime();
				if (at >= windowStart && at <= now) {
					items.push({
						id: `fired-${fire.id}`,
						name: schedule.name,
						time: `${formatClock(fire.actualTriggerTime)} ✓`,
						positionPercent: ((at - windowStart) / WINDOW_MS) * 100,
						fired: true
					});
				}
			}
			if (schedule.status === 'active' && schedule.nextRunAt) {
				const at = new Date(schedule.nextRunAt).getTime();
				if (at > now && at <= windowStart + WINDOW_MS) {
					items.push({
						id: `next-${schedule.id}`,
						name: schedule.name,
						time: formatClock(schedule.nextRunAt),
						positionPercent: ((at - windowStart) / WINDOW_MS) * 100,
						fired: false
					});
				}
			}
		}

		return items.sort((a, b) => a.positionPercent - b.positionPercent);
	});
</script>

<div class="timeline" aria-label="Next 24 hours of schedule fires">
	<div class="timeline-head">
		<span class="timeline-label">Next 24 hours</span>
		<span class="spacer"></span>
		<span class="legend"><span class="legend-dot fired"></span>fired</span>
		<span class="legend"><span class="legend-dot upcoming"></span>upcoming</span>
	</div>
	<div class="track-area">
		{#if fires.length > 0}
			<div class="track"></div>
			<div class="now-marker" style="left: {NOW_POSITION_PERCENT}%" title="now"></div>
			{#each fires as fire (fire.id)}
				<div class="fire" style="left: {fire.positionPercent}%">
					<span class="fire-name">{fire.name}</span>
					<span class="fire-dot" class:fired={fire.fired}></span>
					<span class="fire-time">{fire.time}</span>
				</div>
			{/each}
		{:else}
			<span class="track-empty">No fires in the next 24 hours.</span>
		{/if}
	</div>
</div>

<style>
	.timeline {
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		padding: 14px 16px 10px;
	}

	.timeline-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
	}

	.timeline-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.spacer {
		flex: 1;
	}

	.legend {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.legend-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.legend-dot.fired {
		background: var(--cinder-success);
	}

	.legend-dot.upcoming {
		border: 1.5px solid var(--cinder-accent);
		box-sizing: border-box;
	}

	.track-area {
		position: relative;
		height: 44px;
	}

	.track {
		position: absolute;
		left: 0;
		right: 0;
		top: 20px;
		height: 2px;
		background: var(--cinder-border-muted);
		border-radius: 1px;
	}

	.now-marker {
		position: absolute;
		top: 16px;
		width: 2px;
		height: 10px;
		background: var(--cinder-danger);
		border-radius: 1px;
	}

	.fire {
		position: absolute;
		top: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		transform: translateX(-50%);
	}

	.fire-name {
		font-family: var(--cinder-font-mono);
		font-size: 9.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.fire-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 1.5px solid var(--cinder-accent);
		box-sizing: border-box;
		background: transparent;
	}

	.fire-dot.fired {
		background: var(--cinder-success);
		border: none;
	}

	.fire-time {
		font-size: 9.5px;
		color: var(--cinder-text-disabled);
		white-space: nowrap;
	}

	.track-empty {
		position: absolute;
		top: 14px;
		left: 0;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-disabled);
	}
</style>
