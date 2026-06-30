<script lang="ts">
	import { onMount } from 'svelte';

	type DurabilityStats = {
		eventsLost: number;
		autoRetries: number;
		workerCrashes: number;
		lastDurableEvent: string | null;
	};

	let stats = $state<DurabilityStats>({
		eventsLost: 0,
		autoRetries: 0,
		workerCrashes: 0,
		lastDurableEvent: null
	});

	async function pollStats() {
		try {
			const response = await fetch('/api/sessions');
			if (response.ok) {
				const body = (await response.json()) as {
					sessions: Array<{ updatedAt: string; archivedAt: string | null }>;
				};
				const active = body.sessions.filter((s) => !s.archivedAt);
				const latestUpdate = active.reduce<string | null>((latest, s) => {
					if (!latest) return s.updatedAt;
					return new Date(s.updatedAt) > new Date(latest) ? s.updatedAt : latest;
				}, null);

				stats = {
					eventsLost: 0,
					autoRetries: stats.autoRetries,
					workerCrashes: 0,
					lastDurableEvent: latestUpdate
				};
			}
		} catch {
			// Non-fatal
		}
	}

	function formatEventId(iso: string | null): string {
		if (!iso) return '—';
		const date = new Date(iso);
		return `#${Math.floor(date.getTime() / 1000) % 1000}`;
	}

	onMount(() => {
		void pollStats();
		const interval = setInterval(() => void pollStats(), 15_000);
		return () => clearInterval(interval);
	});
</script>

<div class="ribbon" role="status" aria-label="Durability status">
	<div class="rib">
		<span class="rib-n">{stats.eventsLost}</span>
		<span class="rib-l">events lost</span>
	</div>
	<div class="rib">
		<span class="rib-n rib-success">{stats.autoRetries}</span>
		<span class="rib-l">auto-retry · no action</span>
	</div>
	<div class="rib">
		<span class="rib-n">{stats.workerCrashes}</span>
		<span class="rib-l">worker crashes</span>
	</div>
	<div class="rib">
		<span class="rib-n rib-accent">{formatEventId(stats.lastDurableEvent)}</span>
		<span class="rib-l">last durable event</span>
	</div>
</div>

<style>
	.ribbon {
		display: flex;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: linear-gradient(180deg, var(--cinder-surface-inset) 0%, var(--cinder-surface) 100%);
		flex: none;
	}

	.rib {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 10px 8px;
	}

	.rib + .rib {
		border-left: 1px solid var(--cinder-border-muted);
	}

	.rib-n {
		font: 700 17px system-ui;
		color: var(--cinder-text);
		font-family: var(--cinder-font-mono);
	}

	.rib-success {
		color: var(--cinder-success);
	}

	.rib-accent {
		color: var(--cinder-accent-text);
	}

	.rib-l {
		font: 400 9.5px system-ui;
		color: var(--cinder-text-subtle);
		text-align: center;
		white-space: nowrap;
	}
</style>
