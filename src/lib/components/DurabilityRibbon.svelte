<script lang="ts">
	import { onMount } from 'svelte';

	type DurabilityStats = {
		activeSessions: number;
		totalRuns: number;
		eventsProcessed: number;
		autoRetries: number;
		workerStatus: 'healthy' | 'degraded' | 'down';
		lastDurableEvent: string | null;
	};

	let stats = $state<DurabilityStats>({
		activeSessions: 0,
		totalRuns: 0,
		eventsProcessed: 0,
		autoRetries: 0,
		workerStatus: 'healthy',
		lastDurableEvent: null
	});

	let temporalReachable = $state(true);

	async function pollStats() {
		try {
			const sessionsResponse = await fetch('/api/sessions');
			if (sessionsResponse.ok) {
				const body = (await sessionsResponse.json()) as {
					sessions: Array<{
						status: string;
						archivedAt: string | null;
						updatedAt: string;
					}>;
				};
				const active = body.sessions.filter((s) => !s.archivedAt);
				const running = active.filter((s) =>
					['running', 'streaming', 'loading', 'waiting_approval'].includes(s.status)
				);

				const latestUpdate = active.reduce<string | null>((latest, s) => {
					if (!latest) return s.updatedAt;
					return new Date(s.updatedAt) > new Date(latest) ? s.updatedAt : latest;
				}, null);

				stats = {
					activeSessions: running.length,
					totalRuns: active.length,
					eventsProcessed: stats.eventsProcessed,
					autoRetries: stats.autoRetries,
					workerStatus: temporalReachable ? 'healthy' : 'degraded',
					lastDurableEvent: latestUpdate
				};
			}
		} catch {
			temporalReachable = false;
			stats = { ...stats, workerStatus: 'down' };
		}
	}

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '—';
		const date = new Date(iso);
		const now = Date.now();
		const seconds = Math.floor((now - date.getTime()) / 1000);
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		return `${hours}h ago`;
	}

	const statusColor = $derived(
		stats.workerStatus === 'healthy'
			? 'var(--cinder-success)'
			: stats.workerStatus === 'degraded'
				? 'var(--cinder-warning)'
				: 'var(--cinder-danger)'
	);

	onMount(() => {
		void pollStats();
		const interval = setInterval(() => void pollStats(), 15_000);
		return () => clearInterval(interval);
	});
</script>

<div class="ribbon" role="status" aria-label="Durability status">
	<div class="ribbon-stat">
		<span class="stat-label">Active</span>
		<span class="stat-value">{stats.activeSessions}</span>
	</div>

	<span class="ribbon-sep" aria-hidden="true"></span>

	<div class="ribbon-stat">
		<span class="stat-label">Sessions</span>
		<span class="stat-value">{stats.totalRuns}</span>
	</div>

	<span class="ribbon-sep" aria-hidden="true"></span>

	<div class="ribbon-stat">
		<span class="stat-label">Worker</span>
		<span class="stat-value">
			<span class="worker-dot" style:background={statusColor}></span>
			<span class="worker-label">{stats.workerStatus}</span>
		</span>
	</div>

	<span class="ribbon-sep" aria-hidden="true"></span>

	<div class="ribbon-stat">
		<span class="stat-label">Last Event</span>
		<span class="stat-value">{formatTimestamp(stats.lastDurableEvent)}</span>
	</div>
</div>

<style>
	.ribbon {
		display: flex;
		align-items: center;
		gap: 16px;
		height: 28px;
		padding: 0 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: var(--cinder-surface-inset);
		font-size: var(--cinder-text-xs);
		flex: none;
	}

	.ribbon-stat {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.stat-label {
		color: var(--cinder-text-disabled);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 600;
	}

	.stat-value {
		color: var(--cinder-text-subtle);
		font-family: var(--cinder-font-mono);
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.ribbon-sep {
		width: 1px;
		height: 14px;
		background: var(--cinder-border-muted);
	}

	.worker-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.worker-label {
		text-transform: capitalize;
	}
</style>
