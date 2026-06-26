<script lang="ts">
	import { onMount } from 'svelte';
	import type { ScheduleProjection } from '$lib/types';

	type RunInspectorProjection = {
		run: {
			id: string;
			sessionId: string;
			workflowId: string;
			status: string;
			model: string | null;
			finalAnswer: string | null;
			startedAt: string | null;
			completedAt: string | null;
		};
		temporalWebUrl: string;
		actionMeter: {
			total: number;
			breakdown: Record<string, number>;
		};
		transcript: Array<{
			id: string;
			kind: string;
			sequence: number;
			createdAt: string;
			payload: unknown;
		}>;
		toolInvocations: Array<{ toolName: string; status: string; idempotencyKey: string | null }>;
		approvalRequests: Array<{ toolName: string; status: string; expiresAt: string }>;
		idempotencyEntries: Array<{ idempotencyKey: string; status: string }>;
		recoveryMarkers: string[];
	};

	type ScheduleForm = {
		name: string;
		description: string;
		cronExpression: string;
		prompt: string;
	};

	let schedules = $state<ScheduleProjection[]>([]);
	let form = $state<ScheduleForm>({
		name: '',
		description: '',
		cronExpression: '0 9 * * *',
		prompt: ''
	});
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let activeScheduleId = $state<string | null>(null);
	let inspectorSessionKey = $state('');
	let inspectorRunId = $state('');
	let inspectorLoading = $state(false);
	let inspectorErrorMessage = $state<string | null>(null);
	let inspector = $state<RunInspectorProjection | null>(null);

	const sortedSchedules = $derived(
		[...schedules].sort((first, second) => first.name.localeCompare(second.name))
	);

	onMount(() => {
		void loadSchedules();
	});

	async function loadSchedules() {
		loading = true;
		errorMessage = null;
		try {
			const response = await fetch('/api/schedules');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { schedules: ScheduleProjection[] };
			schedules = body.schedules;
		} catch (caught) {
			errorMessage = messageFromCaught(caught, 'Failed to load schedules');
		} finally {
			loading = false;
		}
	}

	async function loadRunInspector() {
		const sessionKey = inspectorSessionKey.trim();
		const runId = inspectorRunId.trim();
		if (!sessionKey || !runId) {
			inspectorErrorMessage = 'Session key and run id are required.';
			return;
		}

		inspectorLoading = true;
		inspectorErrorMessage = null;
		try {
			const response = await fetch(
				`/api/sessions/${encodeURIComponent(sessionKey)}/runs/${encodeURIComponent(runId)}/inspector`
			);
			if (!response.ok) throw new Error(await response.text());
			inspector = (await response.json()) as RunInspectorProjection;
		} catch (caught) {
			inspectorErrorMessage = messageFromCaught(caught, 'Failed to load run inspector');
		} finally {
			inspectorLoading = false;
		}
	}

	async function createSchedule() {
		saving = true;
		errorMessage = null;
		try {
			const response = await fetch('/api/schedules', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: form.name,
					description: form.description,
					cronExpression: form.cronExpression,
					prompt: form.prompt
				})
			});
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { schedule: ScheduleProjection };
			upsertSchedule(body.schedule);
			form = {
				name: '',
				description: '',
				cronExpression: form.cronExpression,
				prompt: ''
			};
		} catch (caught) {
			errorMessage = messageFromCaught(caught, 'Failed to create schedule');
		} finally {
			saving = false;
		}
	}

	async function triggerSchedule(scheduleId: string) {
		const response = await runScheduleAction(scheduleId, 'trigger');
		if (!response) return;
		const body = (await response.json()) as { schedule: ScheduleProjection };
		upsertSchedule(body.schedule);
	}

	async function pauseSchedule(scheduleId: string) {
		const response = await runScheduleAction(scheduleId, 'pause');
		if (!response) return;
		const body = (await response.json()) as { schedule: ScheduleProjection };
		upsertSchedule(body.schedule);
	}

	async function resumeSchedule(scheduleId: string) {
		const response = await runScheduleAction(scheduleId, 'resume');
		if (!response) return;
		const body = (await response.json()) as { schedule: ScheduleProjection };
		upsertSchedule(body.schedule);
	}

	async function deleteSchedule(scheduleId: string) {
		activeScheduleId = scheduleId;
		errorMessage = null;
		try {
			const response = await fetch(`/api/schedules/${scheduleId}`, { method: 'DELETE' });
			if (!response.ok) throw new Error(await response.text());
			schedules = schedules.filter((schedule) => schedule.temporalScheduleId !== scheduleId);
		} catch (caught) {
			errorMessage = messageFromCaught(caught, 'Failed to delete schedule');
		} finally {
			activeScheduleId = null;
		}
	}

	async function runScheduleAction(scheduleId: string, action: 'trigger' | 'pause' | 'resume') {
		activeScheduleId = scheduleId;
		errorMessage = null;
		try {
			const response = await fetch(`/api/schedules/${scheduleId}/${action}`, { method: 'POST' });
			if (!response.ok) throw new Error(await response.text());
			return response;
		} catch (caught) {
			errorMessage = messageFromCaught(caught, `Failed to ${action} schedule`);
			return null;
		} finally {
			activeScheduleId = null;
		}
	}

	function upsertSchedule(nextSchedule: ScheduleProjection) {
		const index = schedules.findIndex(
			(schedule) => schedule.temporalScheduleId === nextSchedule.temporalScheduleId
		);
		if (index === -1) {
			schedules = [...schedules, nextSchedule];
			return;
		}

		schedules = schedules.map((schedule, scheduleIndex) =>
			scheduleIndex === index ? nextSchedule : schedule
		);
	}

	function messageFromCaught(caught: unknown, fallback: string) {
		return caught instanceof Error && caught.message ? caught.message : fallback;
	}

	function formatScheduleDate(value: string | null) {
		return value ? new Date(value).toLocaleString() : 'None';
	}

	function formatPayload(value: unknown) {
		return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	}

	function openTemporalWeb(url: string) {
		window.open(url, '_blank', 'noreferrer');
	}
</script>

<svelte:head>
	<title>Stardust Operations Console</title>
</svelte:head>

<main class="schedule-manager">
	<header class="page-header">
		<div>
			<p class="eyebrow">Stardust</p>
			<h1>Operations Console</h1>
		</div>
		<button type="button" class="secondary" onclick={loadSchedules} disabled={loading}>
			Refresh
		</button>
	</header>

	{#if errorMessage}
		<p class="error">{errorMessage}</p>
	{/if}

	<section class="create-panel" aria-labelledby="run-inspector-heading">
		<div class="section-heading">
			<div>
				<h2 id="run-inspector-heading">Run Inspector</h2>
				<p class="muted">SQLite rehydration, Temporal Web links, and action meter.</p>
			</div>
			{#if inspector}
				<button
					type="button"
					class="temporal-link"
					onclick={() => openTemporalWeb(inspector!.temporalWebUrl)}
				>
					Temporal Web
				</button>
			{/if}
		</div>

		<form
			class="inspector-form"
			onsubmit={(event) => {
				event.preventDefault();
				void loadRunInspector();
			}}
		>
			<label>
				Session Key
				<input bind:value={inspectorSessionKey} required autocomplete="off" />
			</label>
			<label>
				Run Id
				<input bind:value={inspectorRunId} required autocomplete="off" />
			</label>
			<button type="submit" disabled={inspectorLoading}>
				{inspectorLoading ? 'Loading' : 'Inspect Run'}
			</button>
		</form>

		{#if inspectorErrorMessage}
			<p class="error">{inspectorErrorMessage}</p>
		{/if}

		{#if inspector}
			<div class="inspector-grid">
				<div class="metric">
					<span>Status</span>
					<strong>{inspector.run.status}</strong>
				</div>
				<div class="metric">
					<span>Workflow</span>
					<strong>{inspector.run.workflowId}</strong>
				</div>
				<div class="metric">
					<span>Actions</span>
					<strong>{inspector.actionMeter.total}</strong>
				</div>
			</div>

			<details open>
				<summary>Action Meter Breakdown</summary>
				<dl class="breakdown-list">
					{#each Object.entries(inspector.actionMeter.breakdown) as [label, count] (label)}
						<div>
							<dt>{label}</dt>
							<dd>{count}</dd>
						</div>
					{/each}
				</dl>
			</details>

			<details open>
				<summary>Transcript Rehydrated From SQLite</summary>
				<div class="timeline">
					{#each inspector.transcript as event (event.id)}
						<article class="timeline-event">
							<div>
								<strong>{event.kind}</strong>
								<span>#{event.sequence} · {formatScheduleDate(event.createdAt)}</span>
							</div>
							<pre>{formatPayload(event.payload)}</pre>
						</article>
					{:else}
						<p class="muted">No transcript events recorded for this run.</p>
					{/each}
				</div>
			</details>

			<details>
				<summary>Recovery and Idempotency</summary>
				<ul class="ledger-list">
					{#each inspector.idempotencyEntries as entry (entry.idempotencyKey)}
						<li>{entry.idempotencyKey}: {entry.status}</li>
					{:else}
						<li>No idempotency entries recorded.</li>
					{/each}
				</ul>
			</details>
		{/if}
	</section>

	<section class="create-panel" aria-labelledby="create-schedule-heading">
		<h2 id="create-schedule-heading">Create Schedule</h2>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void createSchedule();
			}}
		>
			<label>
				Name
				<input bind:value={form.name} required autocomplete="off" />
			</label>
			<label>
				Description
				<input bind:value={form.description} autocomplete="off" />
			</label>
			<label>
				Cron Expression
				<input bind:value={form.cronExpression} required autocomplete="off" />
			</label>
			<label class="prompt-field">
				Prompt
				<textarea bind:value={form.prompt} required rows="4"></textarea>
			</label>
			<button type="submit" disabled={saving}>{saving ? 'Creating' : 'Create Schedule'}</button>
		</form>
	</section>

	<section aria-labelledby="schedule-list-heading">
		<h2 id="schedule-list-heading">Schedules</h2>

		{#if loading}
			<p class="muted">Loading schedules...</p>
		{:else if sortedSchedules.length === 0}
			<p class="muted">No schedules configured.</p>
		{:else}
			<div class="schedule-list">
				{#each sortedSchedules as schedule (schedule.temporalScheduleId)}
					<article class="schedule-row">
						<div class="schedule-summary">
							<div>
								<h3>{schedule.name}</h3>
								{#if schedule.description}
									<p>{schedule.description}</p>
								{/if}
							</div>
							<span class:paused={schedule.status === 'paused'}>{schedule.status}</span>
						</div>
						<dl>
							<div>
								<dt>Cron</dt>
								<dd>{schedule.cronExpression}</dd>
							</div>
							<div>
								<dt>Next Run</dt>
								<dd>{formatScheduleDate(schedule.nextRunAt)}</dd>
							</div>
							<div>
								<dt>Last Run</dt>
								<dd>{formatScheduleDate(schedule.lastRunAt)}</dd>
							</div>
						</dl>
						<p class="prompt">{schedule.prompt}</p>
						<div class="actions">
							<button
								type="button"
								class="secondary"
								onclick={() => void triggerSchedule(schedule.temporalScheduleId)}
								disabled={activeScheduleId === schedule.temporalScheduleId}
							>
								Trigger Now
							</button>
							{#if schedule.status === 'paused'}
								<button
									type="button"
									class="secondary"
									onclick={() => void resumeSchedule(schedule.temporalScheduleId)}
									disabled={activeScheduleId === schedule.temporalScheduleId}
								>
									Resume
								</button>
							{:else}
								<button
									type="button"
									class="secondary"
									onclick={() => void pauseSchedule(schedule.temporalScheduleId)}
									disabled={activeScheduleId === schedule.temporalScheduleId}
								>
									Pause
								</button>
							{/if}
							<button
								type="button"
								class="danger"
								onclick={() => void deleteSchedule(schedule.temporalScheduleId)}
								disabled={activeScheduleId === schedule.temporalScheduleId}
							>
								Delete
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f6f7f8;
		color: #1d252c;
		font-family:
			Inter,
			ui-sans-serif,
			system-ui,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}

	button,
	input,
	textarea {
		font: inherit;
	}

	.schedule-manager {
		width: min(1120px, calc(100vw - 40px));
		margin: 0 auto;
		padding: 32px 0 48px;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 24px;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: #5e6f80;
		font-size: 0.85rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 0;
		font-size: clamp(2rem, 6vw, 3.25rem);
		line-height: 1;
	}

	h2 {
		margin-bottom: 16px;
		font-size: 1.1rem;
	}

	.create-panel,
	.schedule-row {
		border: 1px solid #d7dde2;
		border-radius: 8px;
		background: #ffffff;
	}

	.create-panel {
		padding: 20px;
		margin-bottom: 28px;
	}

	form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}

	label {
		display: grid;
		gap: 6px;
		color: #40505f;
		font-size: 0.9rem;
		font-weight: 700;
	}

	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid #c8d0d8;
		border-radius: 6px;
		padding: 10px 12px;
		color: #17202a;
		background: #ffffff;
	}

	textarea {
		resize: vertical;
	}

	.prompt-field {
		grid-column: 1 / -1;
	}

	.inspector-form {
		grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
		align-items: end;
		margin-bottom: 16px;
	}

	.section-heading {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.section-heading h2,
	.section-heading p {
		margin-bottom: 0;
	}

	.temporal-link {
		border: 1px solid #174c77;
		border-radius: 6px;
		padding: 9px 12px;
		color: #174c77;
		font-weight: 800;
		text-decoration: none;
		white-space: nowrap;
	}

	.inspector-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin: 16px 0;
	}

	.metric {
		border: 1px solid #d7dde2;
		border-radius: 6px;
		padding: 12px;
		background: #f9fafb;
	}

	.metric span {
		display: block;
		color: #5e6f80;
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.metric strong {
		display: block;
		margin-top: 4px;
		overflow-wrap: anywhere;
		font-size: 1rem;
	}

	details {
		border-top: 1px solid #e7ebef;
		padding-top: 12px;
		margin-top: 12px;
	}

	summary {
		cursor: pointer;
		font-weight: 800;
	}

	.breakdown-list {
		margin-top: 12px;
	}

	.timeline {
		display: grid;
		gap: 10px;
		margin-top: 12px;
	}

	.timeline-event {
		border: 1px solid #d7dde2;
		border-radius: 6px;
		padding: 12px;
		background: #ffffff;
	}

	.timeline-event div {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 8px;
	}

	.timeline-event span {
		color: #5e6f80;
		font-size: 0.85rem;
	}

	pre {
		overflow-x: auto;
		margin: 10px 0 0;
		border-radius: 6px;
		padding: 10px;
		background: #17202a;
		color: #f6f7f8;
		font-size: 0.82rem;
	}

	.ledger-list {
		margin: 12px 0 0;
		padding-left: 20px;
	}

	button {
		min-height: 40px;
		border: 1px solid #174c77;
		border-radius: 6px;
		padding: 0 14px;
		color: #ffffff;
		background: #174c77;
		font-weight: 700;
		cursor: pointer;
	}

	form button {
		justify-self: start;
	}

	button.secondary {
		color: #174c77;
		background: #ffffff;
	}

	button.danger {
		border-color: #9b2c2c;
		color: #9b2c2c;
		background: #ffffff;
	}

	button:disabled {
		opacity: 0.55;
		cursor: wait;
	}

	.error {
		border-left: 4px solid #9b2c2c;
		padding: 12px 14px;
		background: #fff1f1;
		color: #7b1d1d;
	}

	.muted {
		color: #5e6f80;
	}

	.schedule-list {
		display: grid;
		gap: 12px;
	}

	.schedule-row {
		display: grid;
		gap: 14px;
		padding: 18px;
	}

	.schedule-summary {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 16px;
	}

	.schedule-summary h3 {
		margin-bottom: 4px;
		font-size: 1rem;
	}

	.schedule-summary p,
	.prompt {
		margin-bottom: 0;
		color: #40505f;
	}

	.schedule-summary span {
		border-radius: 999px;
		padding: 4px 10px;
		background: #e6f3ed;
		color: #17603a;
		font-size: 0.8rem;
		font-weight: 800;
		text-transform: capitalize;
	}

	.schedule-summary span.paused {
		background: #fff3d7;
		color: #775000;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin: 0;
	}

	dt {
		color: #5e6f80;
		font-size: 0.8rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	dd {
		margin: 3px 0 0;
		overflow-wrap: anywhere;
	}

	.prompt {
		border-top: 1px solid #e7ebef;
		padding-top: 12px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	@media (max-width: 760px) {
		.schedule-manager {
			width: min(100vw - 24px, 1120px);
			padding-top: 20px;
		}

		.page-header,
		.schedule-summary {
			align-items: stretch;
			flex-direction: column;
		}

		form,
		.inspector-form,
		.inspector-grid,
		dl {
			grid-template-columns: 1fr;
		}

		.section-heading {
			align-items: stretch;
			flex-direction: column;
		}

		button {
			width: 100%;
		}

		.temporal-link {
			text-align: center;
		}
	}
</style>
