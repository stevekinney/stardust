<script lang="ts">
	import { onMount } from 'svelte';
	import type { ScheduleProjection } from '$lib/types';

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
</script>

<svelte:head>
	<title>Stardust Schedule Manager</title>
</svelte:head>

<main class="schedule-manager">
	<header class="page-header">
		<div>
			<p class="eyebrow">Stardust</p>
			<h1>Schedule Manager</h1>
		</div>
		<button type="button" class="secondary" onclick={loadSchedules} disabled={loading}>
			Refresh
		</button>
	</header>

	{#if errorMessage}
		<p class="error">{errorMessage}</p>
	{/if}

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
		dl {
			grid-template-columns: 1fr;
		}

		button {
			width: 100%;
		}
	}
</style>
