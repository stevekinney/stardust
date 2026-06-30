<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';

	type Schedule = {
		id: string;
		temporalScheduleId: string;
		targetSessionKey: string;
		name: string;
		description: string | null;
		cronExpression: string;
		prompt: string;
		status: 'active' | 'paused' | 'deleted';
		lastRunAt: string | null;
		nextRunAt: string | null;
		createdAt: string;
		updatedAt: string;
	};

	let schedules = $state<Schedule[]>([]);
	let selected = $state<Schedule | null>(null);
	let loading = $state(true);

	let activeCount = $derived(schedules.filter((s) => s.status === 'active').length);
	let headerMeta = $derived.by(() => {
		if (schedules.length === 0) return 'No schedules';
		return `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} · ${activeCount} active`;
	});

	function humanCron(cron: string): string {
		const parts = cron.split(' ');
		if (parts.length < 5) return cron;
		const [minute, hour, , , dayOfWeek] = parts;
		const time = `${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`;
		if (dayOfWeek === '*') return `Every day at ${time}`;
		const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const dayName = days[Number(dayOfWeek)] ?? dayOfWeek;
		return `${dayName}s at ${time}`;
	}

	function timeUntil(iso: string | null): string {
		if (!iso) return '—';
		const ms = new Date(iso).getTime() - Date.now();
		if (ms <= 0) return 'overdue';
		const hours = Math.floor(ms / 3600000);
		const minutes = Math.floor((ms % 3600000) / 60000);
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}

	function timeAgo(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.now() - new Date(iso).getTime();
		const minutes = Math.floor(ms / 60000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	async function triggerSchedule(scheduleId: string) {
		await fetch(`/api/schedules/${scheduleId}/trigger`, { method: 'POST' });
		await loadSchedules();
	}

	async function pauseSchedule(scheduleId: string) {
		await fetch(`/api/schedules/${scheduleId}/pause`, { method: 'POST' });
		await loadSchedules();
	}

	async function resumeSchedule(scheduleId: string) {
		await fetch(`/api/schedules/${scheduleId}/resume`, { method: 'POST' });
		await loadSchedules();
	}

	async function loadSchedules() {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const response = await fetch('/api/schedules', { signal: controller.signal });
			clearTimeout(timeout);
			if (response.ok) {
				const body = (await response.json()) as { schedules: Schedule[] };
				schedules = body.schedules;
				if (!selected && schedules.length > 0) {
					selected = schedules[0];
				} else if (selected) {
					selected = schedules.find((s) => s.id === selected!.id) ?? selected;
				}
			}
		} catch {
			// Non-fatal
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadSchedules();
		const interval = setInterval(() => void loadSchedules(), 15_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Schedules — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<h1 class="page-title">Schedules</h1>
		<span class="page-meta">{headerMeta}</span>
		<span class="spacer"></span>
		<Button variant="primary" size="sm">
			<span style="display:inline-flex;align-items:center;gap:7px">
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M5 12h14" />
					<path d="M12 5v14" />
				</svg>
				New schedule
			</span>
		</Button>
	</div>

	{#if loading}
		<div class="page-center"><span class="page-meta">Loading…</span></div>
	{:else if schedules.length === 0}
		<div class="page-center">
			<div class="empty">
				<div class="empty-icon">
					<svg
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M8 2v4" />
						<path d="M16 2v4" />
						<rect width="18" height="18" x="3" y="4" rx="2" />
						<path d="M3 10h18" />
						<path d="M8 14h.01" />
						<path d="M12 14h.01" />
						<path d="M16 14h.01" />
						<path d="M8 18h.01" />
						<path d="M12 18h.01" />
						<path d="M16 18h.01" />
					</svg>
				</div>
				<h2 class="empty-heading">No schedules</h2>
				<p class="empty-description">
					Schedules are recurring tasks the agent picks up automatically. Create one to run evals,
					checks, or maintenance on a cadence.
				</p>
			</div>
		</div>
	{:else}
		<div class="split">
			<div class="sidebar">
				{#each schedules as schedule (schedule.id)}
					<button
						class="sched-card"
						class:active={selected?.id === schedule.id}
						class:paused={schedule.status === 'paused'}
						onclick={() => (selected = schedule)}
					>
						<div class="sched-top">
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								style="color:{schedule.status === 'active'
									? 'var(--cinder-accent-text)'
									: 'var(--cinder-text-subtle)'}"
							>
								<path d="M8 2v4" />
								<path d="M16 2v4" />
								<rect width="18" height="18" x="3" y="4" rx="2" />
								<path d="M3 10h18" />
								<path d="M16 14h.01" />
								<path d="M16 18h.01" />
							</svg>
							<span class="sched-name">{schedule.name}</span>
							<span class="spacer"></span>
							<span
								class="status-pill"
								class:status-active={schedule.status === 'active'}
								class:status-paused={schedule.status === 'paused'}
							>
								<i
									class="dot"
									style="background:{schedule.status === 'active'
										? 'var(--cinder-success)'
										: 'var(--cinder-text-disabled)'}"
								></i>
								{schedule.status === 'active' ? 'Active' : 'Paused'}
							</span>
						</div>
						<div class="sched-cadence">{humanCron(schedule.cronExpression)}</div>
						<div class="sched-cron">cron {schedule.cronExpression}</div>
					</button>
				{/each}
			</div>

			<div class="detail">
				{#if selected}
					<div class="detail-top">
						<div class="detail-info">
							<div class="detail-name-row">
								<h2 class="detail-name">{selected.name}</h2>
								<span
									class="status-badge"
									class:status-badge-active={selected.status === 'active'}
									class:status-badge-paused={selected.status === 'paused'}
								>
									<i
										class="dot"
										style="background:{selected.status === 'active'
											? 'var(--cinder-success)'
											: 'var(--cinder-text-disabled)'}"
									></i>
									{selected.status === 'active' ? 'Active' : 'Paused'}
								</span>
							</div>
							<div class="detail-sub">
								Runs {humanCron(selected.cronExpression).toLowerCase()} · next run in {timeUntil(
									selected.nextRunAt
								)} · submits into session <span class="mono">{selected.targetSessionKey}</span>
							</div>
						</div>
						<div class="detail-actions">
							<Button
								variant="primary"
								size="sm"
								label="Trigger now"
								onclick={() => triggerSchedule(selected!.id)}
							/>
							{#if selected.status === 'active'}
								<Button
									variant="secondary"
									size="sm"
									label="Pause"
									onclick={() => pauseSchedule(selected!.id)}
								/>
							{:else}
								<Button
									variant="secondary"
									size="sm"
									label="Resume"
									onclick={() => resumeSchedule(selected!.id)}
								/>
							{/if}
						</div>
					</div>

					<div class="prompt-card">
						<div class="prompt-label">The task it submits each run</div>
						<div class="prompt-text">"{selected.prompt}"</div>
						<div class="prompt-meta">
							<div class="meta-col">
								<div class="meta-key">Cadence</div>
								<div class="meta-val">{humanCron(selected.cronExpression)}</div>
							</div>
							<div class="meta-col">
								<div class="meta-key">Overlap</div>
								<div class="meta-val">Skip if still running</div>
							</div>
							<div class="meta-col">
								<div class="meta-key">Spec</div>
								<div class="meta-val">
									<span class="mono lns"
										>Temporal Schedule · {selected.temporalScheduleId.slice(0, 10)}</span
									>
								</div>
							</div>
						</div>
					</div>

					<div class="runs-section">
						<div class="runs-label">Runs it produced</div>
						{#if selected.lastRunAt}
							<div class="run-row">
								<i class="dot" style="background:var(--cinder-success)"></i>
								<span class="run-time">Last run · {timeAgo(selected.lastRunAt)}</span>
								<span class="spacer"></span>
								<span class="badge badge-success">Complete</span>
							</div>
						{:else}
							<p class="page-meta">No runs yet.</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.page-header {
		flex: none;
		padding: 18px 22px 14px;
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.page-title {
		font: 650 20px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.page-meta {
		font: 500 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.spacer {
		flex: 1;
	}

	.page-center {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px;
	}

	.empty {
		text-align: center;
		max-width: 380px;
	}

	.empty-icon {
		width: 52px;
		height: 52px;
		border-radius: 14px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border);
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto 16px;
		color: var(--cinder-text-subtle);
	}

	.empty-heading {
		font: 650 18px system-ui;
		margin: 0 0 8px;
		color: var(--cinder-text);
	}

	.empty-description {
		font: 400 13px/1.6 system-ui;
		margin: 0;
		color: var(--cinder-text-muted);
	}

	.split {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.sidebar {
		width: 340px;
		flex: none;
		border-right: 1px solid var(--cinder-border);
		overflow: auto;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.sched-card {
		all: unset;
		cursor: pointer;
		border: 1px solid var(--cinder-border);
		border-radius: 11px;
		padding: 13px;
		display: block;
		text-align: left;
	}

	.sched-card.active {
		border: 1.5px solid var(--cinder-accent);
		background: var(--cinder-surface-inset);
	}

	.sched-card.paused {
		opacity: 0.78;
	}

	.sched-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.sched-name {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.status-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font: 600 10px system-ui;
	}

	.status-active {
		color: var(--cinder-color-success-fg);
	}

	.status-paused {
		color: var(--cinder-text-subtle);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
		flex: none;
	}

	.sched-cadence {
		font: 500 11.5px system-ui;
		color: var(--cinder-text-subtle);
		margin-top: 7px;
	}

	.sched-cron {
		font: 400 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 8px;
		opacity: 0.7;
	}

	.detail {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 22px 24px;
	}

	.detail-top {
		display: flex;
		align-items: flex-start;
		gap: 14px;
	}

	.detail-info {
		flex: 1;
	}

	.detail-name-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.detail-name {
		font: 650 19px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border-radius: 20px;
		padding: 3px 10px;
		font: 600 10.5px system-ui;
	}

	.status-badge-active {
		border: 1px solid var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-badge-paused {
		border: 1px solid var(--cinder-border);
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.detail-sub {
		font: 400 12.5px system-ui;
		color: var(--cinder-text-subtle);
		margin-top: 5px;
	}

	.detail-actions {
		display: flex;
		gap: 8px;
	}

	.prompt-card {
		border: 1px solid var(--cinder-border);
		border-radius: 11px;
		background: var(--cinder-surface);
		padding: 15px 16px;
		margin-top: 18px;
	}

	.prompt-label {
		font: 600 10px system-ui;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
		margin-bottom: 8px;
	}

	.prompt-text {
		font: 400 13.5px/1.55 system-ui;
		color: var(--cinder-text);
	}

	.prompt-meta {
		display: flex;
		gap: 18px;
		margin-top: 13px;
		padding-top: 12px;
		border-top: 1px solid var(--cinder-border-muted);
	}

	.meta-col {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.meta-key {
		font: 500 10px system-ui;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cinder-text-subtle);
	}

	.meta-val {
		font: 500 12.5px system-ui;
		color: var(--cinder-text);
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	.lns {
		font: 400 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
	}

	.runs-section {
		margin-top: 20px;
	}

	.runs-label {
		font: 600 10px system-ui;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
		margin-bottom: 10px;
	}

	.run-row {
		display: flex;
		align-items: center;
		gap: 11px;
		border: 1px solid var(--cinder-border);
		border-radius: 9px;
		padding: 11px 13px;
	}

	.run-time {
		font: 600 12.5px system-ui;
		color: var(--cinder-text);
	}

	.badge {
		display: inline-block;
		font: 600 10px system-ui;
		padding: 2px 7px;
		border-radius: 6px;
	}

	.badge-success {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}
</style>
