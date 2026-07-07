<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import Textarea from '@lostgradient/cinder/textarea';
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
	let schedulesLoading = $state(true);
	let saving = $state(false);
	let schedulesError = $state<string | null>(null);
	let activeScheduleId = $state<string | null>(null);

	const sortedSchedules = $derived(
		[...schedules].sort((first, second) => first.name.localeCompare(second.name))
	);

	onMount(() => {
		void loadSchedules();
	});

	async function loadSchedules() {
		schedulesLoading = true;
		schedulesError = null;
		try {
			const response = await fetch('/api/schedules');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { schedules: ScheduleProjection[] };
			schedules = body.schedules;
		} catch (caught) {
			schedulesError = messageFromCaught(caught, 'Failed to load schedules');
		} finally {
			schedulesLoading = false;
		}
	}

	async function createSchedule() {
		saving = true;
		schedulesError = null;
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
			form = { name: '', description: '', cronExpression: form.cronExpression, prompt: '' };
		} catch (caught) {
			schedulesError = messageFromCaught(caught, 'Failed to create schedule');
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
		schedulesError = null;
		try {
			const response = await fetch(`/api/schedules/${scheduleId}`, { method: 'DELETE' });
			if (!response.ok) throw new Error(await response.text());
			schedules = schedules.filter((schedule) => schedule.temporalScheduleId !== scheduleId);
		} catch (caught) {
			schedulesError = messageFromCaught(caught, 'Failed to delete schedule');
		} finally {
			activeScheduleId = null;
		}
	}

	async function runScheduleAction(scheduleId: string, action: 'trigger' | 'pause' | 'resume') {
		activeScheduleId = scheduleId;
		schedulesError = null;
		try {
			const response = await fetch(`/api/schedules/${scheduleId}/${action}`, { method: 'POST' });
			if (!response.ok) throw new Error(await response.text());
			return response;
		} catch (caught) {
			schedulesError = messageFromCaught(caught, `Failed to ${action} schedule`);
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
		schedules = schedules.map((schedule, i) => (i === index ? nextSchedule : schedule));
	}

	function messageFromCaught(caught: unknown, fallback: string) {
		if (caught instanceof Error && caught.message) {
			try {
				const parsed = JSON.parse(caught.message) as { message?: string };
				return parsed.message ?? caught.message;
			} catch {
				return caught.message;
			}
		}
		return fallback;
	}

	function formatDate(value: string | null) {
		return value ? new Date(value).toLocaleString() : 'None';
	}
</script>

<section class="panel" aria-labelledby="create-schedule-heading">
	<div class="section-heading">
		<h2 id="create-schedule-heading">Create Schedule</h2>
		<Button
			variant="ghost"
			size="sm"
			label="Refresh Schedules"
			onclick={loadSchedules}
			disabled={schedulesLoading}
		/>
	</div>
	{#if schedulesError}
		<p class="error">{schedulesError}</p>
	{/if}
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void createSchedule();
		}}
	>
		<Input id="schedule-name" label="Name" bind:value={form.name} required autocomplete="off" />
		<Input
			id="schedule-description"
			label="Description"
			bind:value={form.description}
			autocomplete="off"
		/>
		<Input
			id="schedule-cron"
			label="Cron Expression"
			bind:value={form.cronExpression}
			required
			autocomplete="off"
		/>
		<Textarea
			id="schedule-prompt"
			label="Prompt"
			bind:value={form.prompt}
			required
			rows={4}
			class="prompt-field"
		/>
		<Button
			label={saving ? 'Creating...' : 'Create Schedule'}
			variant="primary"
			type="submit"
			disabled={saving}
			class="form-submit"
		/>
	</form>
</section>

<section aria-labelledby="schedule-list-heading">
	<h2 id="schedule-list-heading">Schedules</h2>

	{#if schedulesLoading}
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
							<dd>{formatDate(schedule.nextRunAt)}</dd>
						</div>
						<div>
							<dt>Last Run</dt>
							<dd>{formatDate(schedule.lastRunAt)}</dd>
						</div>
					</dl>
					<p class="prompt">{schedule.prompt}</p>
					<div class="actions">
						<Button
							label="Trigger Now"
							variant="secondary"
							size="sm"
							onclick={() => void triggerSchedule(schedule.temporalScheduleId)}
							disabled={activeScheduleId === schedule.temporalScheduleId}
						/>
						{#if schedule.status === 'paused'}
							<Button
								label="Resume"
								variant="secondary"
								size="sm"
								onclick={() => void resumeSchedule(schedule.temporalScheduleId)}
								disabled={activeScheduleId === schedule.temporalScheduleId}
							/>
						{:else}
							<Button
								label="Pause"
								variant="secondary"
								size="sm"
								onclick={() => void pauseSchedule(schedule.temporalScheduleId)}
								disabled={activeScheduleId === schedule.temporalScheduleId}
							/>
						{/if}
						<Button
							label="Delete"
							variant="danger"
							size="sm"
							onclick={() => void deleteSchedule(schedule.temporalScheduleId)}
							disabled={activeScheduleId === schedule.temporalScheduleId}
						/>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</section>

<style>
	.panel,
	.schedule-row {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
	}

	.panel {
		padding: 20px;
	}

	.section-heading,
	.schedule-summary,
	.actions {
		display: flex;
		gap: 16px;
	}

	.section-heading,
	.schedule-summary {
		align-items: start;
		justify-content: space-between;
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

	.schedule-summary h3 {
		margin-bottom: 4px;
		font-size: 1rem;
	}

	.schedule-summary p,
	.prompt {
		margin-bottom: 0;
		color: var(--cinder-text-muted);
	}

	.schedule-summary span {
		flex-shrink: 0;
		border-radius: var(--cinder-radius-full);
		padding: 4px 10px;
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
		font-size: var(--cinder-text-xs);
		font-weight: 800;
		text-transform: capitalize;
	}

	.schedule-summary span.paused {
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin: 0;
	}

	dt {
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
		font-weight: 800;
		text-transform: uppercase;
	}

	dd {
		margin: 3px 0 0;
		overflow-wrap: anywhere;
	}

	.prompt {
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 12px;
	}

	form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}

	:global(.prompt-field) {
		grid-column: 1 / -1;
	}

	:global(.form-submit) {
		justify-self: start;
	}

	.actions {
		flex-wrap: wrap;
		gap: 8px;
	}

	.error {
		border-left: 4px solid var(--cinder-danger);
		margin: 0 0 1rem;
		padding: 12px 14px;
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.muted {
		margin: 0;
		color: var(--cinder-text-subtle);
	}

	@media (max-width: 760px) {
		.section-heading,
		.schedule-summary {
			align-items: stretch;
			flex-direction: column;
		}

		form,
		dl {
			grid-template-columns: 1fr;
		}
	}
</style>
