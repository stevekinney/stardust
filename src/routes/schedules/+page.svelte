<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import Textarea from '@lostgradient/cinder/textarea';
	import ScheduleRow from '$lib/components/schedule-row.svelte';
	import ScheduleTimeline from '$lib/components/schedule-timeline.svelte';
	import type { ScheduleProjection } from '$lib/types';

	type ScheduleForm = {
		name: string;
		description: string;
		cronExpression: string;
		prompt: string;
	};

	const emptyForm: ScheduleForm = {
		name: '',
		description: '',
		cronExpression: '0 9 * * 1',
		prompt: ''
	};

	let schedules = $state<ScheduleProjection[]>([]);
	let loading = $state(true);
	let showCreateForm = $state(false);
	let saving = $state(false);
	let formError = $state<string | null>(null);
	let form = $state<ScheduleForm>({ ...emptyForm });

	async function triggerSchedule(schedule: ScheduleProjection) {
		await fetch(`/api/schedules/${schedule.temporalScheduleId}/trigger`, { method: 'POST' });
		await loadSchedules();
	}

	async function pauseSchedule(schedule: ScheduleProjection) {
		await fetch(`/api/schedules/${schedule.temporalScheduleId}/pause`, { method: 'POST' });
		await loadSchedules();
	}

	async function resumeSchedule(schedule: ScheduleProjection) {
		await fetch(`/api/schedules/${schedule.temporalScheduleId}/resume`, { method: 'POST' });
		await loadSchedules();
	}

	function resetForm() {
		form = { ...emptyForm };
		formError = null;
	}

	function upsertSchedule(nextSchedule: ScheduleProjection) {
		const index = schedules.findIndex(
			(schedule) => schedule.temporalScheduleId === nextSchedule.temporalScheduleId
		);
		if (index === -1) {
			schedules = [...schedules, nextSchedule];
			return;
		}
		schedules = schedules.map((schedule, currentIndex) =>
			currentIndex === index ? nextSchedule : schedule
		);
	}

	async function createSchedule() {
		saving = true;
		formError = null;
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
			showCreateForm = false;
			resetForm();
		} catch (caught) {
			formError = caught instanceof Error ? caught.message : 'Failed to create schedule';
		} finally {
			saving = false;
		}
	}

	async function loadSchedules() {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const response = await fetch('/api/schedules', { signal: controller.signal });
			clearTimeout(timeout);
			if (response.ok) {
				const body = (await response.json()) as { schedules: ScheduleProjection[] };
				schedules = body.schedules;
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
	<div class="page-head">
		<h1 class="page-title">Schedules</h1>
		<span class="page-sub">Native Temporal Schedules — they fire even when this app is closed.</span
		>
		<span class="spacer"></span>
		<Button
			variant="primary"
			size="sm"
			label="New schedule"
			onclick={() => (showCreateForm = true)}
		/>
	</div>

	{#if showCreateForm}
		<section class="create-panel" aria-labelledby="create-schedule-heading">
			<div class="create-panel-header">
				<div>
					<h2 id="create-schedule-heading" class="create-heading">Create schedule</h2>
					<p class="create-description">Run a recurring agent task on a Temporal schedule.</p>
				</div>
				<Button
					variant="secondary"
					size="sm"
					label="Cancel"
					onclick={() => {
						showCreateForm = false;
						resetForm();
					}}
				/>
			</div>

			{#if formError}
				<p class="form-error" role="alert">{formError}</p>
			{/if}

			<form
				class="create-form"
				onsubmit={(event) => {
					event.preventDefault();
					void createSchedule();
				}}
			>
				<div class="form-grid">
					<Input
						id="schedule-name"
						label="Name"
						bind:value={form.name}
						required
						autocomplete="off"
					/>
					<Input
						id="schedule-cron"
						label="Cron expression"
						bind:value={form.cronExpression}
						required
						autocomplete="off"
					/>
				</div>
				<Input
					id="schedule-description"
					label="Description"
					bind:value={form.description}
					autocomplete="off"
				/>
				<Textarea id="schedule-prompt" label="Prompt" bind:value={form.prompt} required rows={4} />
				<div class="form-actions">
					<span class="spacer"></span>
					<Button
						label={saving ? 'Creating…' : 'Create schedule'}
						variant="primary"
						type="submit"
						disabled={saving}
					/>
				</div>
			</form>
		</section>
	{/if}

	{#if loading}
		<p class="state-text" aria-busy="true">Loading…</p>
	{:else if schedules.length === 0}
		<div class="empty">
			<h2 class="empty-heading">No schedules</h2>
			<p class="empty-description">
				Schedules are recurring tasks the agent picks up automatically — they fire at their cron
				time whether or not this app is open. Create one to run evals, checks, or maintenance on a
				cadence.
			</p>
		</div>
	{:else}
		<ScheduleTimeline {schedules} />

		<div class="rows">
			{#each schedules as schedule (schedule.id)}
				<ScheduleRow
					{schedule}
					onPause={pauseSchedule}
					onResume={resumeSchedule}
					onTrigger={triggerSchedule}
				/>
			{/each}
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
		align-items: center;
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

	.spacer {
		flex: 1;
	}

	.state-text {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* ── Create panel ── */

	.create-panel {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.create-panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.create-heading {
		margin: 0;
		font-size: var(--cinder-text-md);
		font-weight: 650;
	}

	.create-description {
		margin: 4px 0 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.form-error {
		margin: 0;
		padding: 8px 12px;
		border: 1px solid var(--cinder-color-danger-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
		font-size: var(--cinder-text-sm);
	}

	.create-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.form-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	/* ── Empty state ── */

	.empty {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 26rem;
		margin: 48px auto 0;
		text-align: center;
	}

	.empty-heading {
		margin: 0;
		font-size: var(--cinder-text-md);
		font-weight: 650;
	}

	.empty-description {
		margin: 0;
		font-size: var(--cinder-text-sm);
		line-height: 1.6;
		color: var(--cinder-text-subtle);
	}
</style>
