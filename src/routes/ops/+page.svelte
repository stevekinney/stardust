<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import Segment from '@lostgradient/cinder/segment';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import Textarea from '@lostgradient/cinder/textarea';
	import type { ScheduleProjection } from '$lib/types';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import type { MemoryNote, MemoryCandidate } from '$lib/server/memory/memory-store';
	import type { ApprovalCardState, ApprovalResolutionInput } from '$lib/types';
	import { viewMode } from '$lib/view-mode.svelte';
	import RunTimeline from '$lib/components/RunTimeline.svelte';
	import MemoryPanel from '$lib/components/MemoryPanel.svelte';
	import WorkspacePanel from '$lib/components/WorkspacePanel.svelte';
	import type {
		WorkspaceFile,
		WorkspaceCommand,
		WorkspaceSnapshot,
		WorkspaceArtifact,
		WorkspaceDiff
	} from '$lib/components/WorkspacePanel.svelte';
	import SandboxInspector from '$lib/components/SandboxInspector.svelte';
	import type {
		SandboxInfo,
		SandboxCommandRow,
		SandboxSnapshotRow
	} from '$lib/components/SandboxInspector.svelte';
	import ApprovalCenter from '$lib/components/ApprovalCenter.svelte';
	import Settings from '$lib/components/Settings.svelte';

	let settingsOpen = $state(false);

	type SessionRow = {
		id: string;
		sessionKey: string;
		status: string;
		workflowId: string;
		createdAt: string;
		updatedAt: string;
	};

	type RunRow = {
		id: string;
		sessionId: string;
		workflowId: string;
		status: string;
		model: string | null;
		finalAnswer: string | null;
		startedAt: string | null;
		completedAt: string | null;
		createdAt: string;
	};

	type ScheduleForm = {
		name: string;
		description: string;
		cronExpression: string;
		prompt: string;
	};

	// — session/run navigation state —
	let sessions = $state<SessionRow[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state<string | null>(null);
	let selectedSession = $state<SessionRow | null>(null);
	let sessionRuns = $state<RunRow[]>([]);
	let runsLoading = $state(false);
	let selectedRun = $state<RunRow | null>(null);

	// — inspector state —
	let inspector = $state<RunInspectorProjection | null>(null);
	let inspectorLoading = $state(false);
	let inspectorError = $state<string | null>(null);

	// — memory panel state —
	let memoryNotes = $state<MemoryNote[]>([]);
	let memoryCandidates = $state<MemoryCandidate[]>([]);
	let memoryLoading = $state(false);
	let editCandidateNotice = $state<string | null>(null);

	// — approval center state —
	let approvals = $state<ApprovalCardState[]>([]);
	let approvalsLoading = $state(false);

	// — sandbox inspector state —
	let sandboxInfo = $state<SandboxInfo | null>(null);
	let sandboxCmds = $state<SandboxCommandRow[]>([]);
	let sandboxSnaps = $state<SandboxSnapshotRow[]>([]);
	let sandboxLoading = $state(false);

	// — workspace panel state —
	let workspaceFiles = $state<WorkspaceFile[]>([]);
	let workspaceCommands = $state<WorkspaceCommand[]>([]);
	let workspaceSnapshots = $state<WorkspaceSnapshot[]>([]);
	let workspaceArtifacts = $state<WorkspaceArtifact[]>([]);
	let workspaceDiffs = $state<WorkspaceDiff[]>([]);

	// — manual inspector fallback —
	let inspectorSessionKey = $state('');
	let inspectorRunId = $state('');
	let inspectorFormError = $state<string | null>(null);

	// — schedules —
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
		void loadSessions();
		void loadSchedules();
	});

	// ── session navigation ──────────────────────────────────────────────────

	async function loadSessions() {
		sessionsLoading = true;
		sessionsError = null;
		try {
			const response = await fetch('/api/sessions');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { sessions: SessionRow[] };
			sessions = body.sessions;
		} catch (caught) {
			sessionsError = messageFromCaught(caught, 'Failed to load sessions');
		} finally {
			sessionsLoading = false;
		}
	}

	async function selectSession(session: SessionRow) {
		selectedSession = session;
		selectedRun = null;
		inspector = null;
		sessionRuns = [];
		runsLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}/runs`);
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { runs: RunRow[] };
			sessionRuns = body.runs.sort(
				(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
		} finally {
			runsLoading = false;
		}
	}

	async function selectRun(run: RunRow, sessionKey: string) {
		selectedRun = run;
		inspector = null;
		inspectorLoading = true;
		inspectorError = null;

		await Promise.all([
			loadInspector(sessionKey, run.id),
			loadMemory(sessionKey),
			loadApprovals(sessionKey),
			loadSandbox(sessionKey),
			loadWorkspace(sessionKey)
		]);
	}

	async function loadInspector(sessionKey: string, runId: string) {
		inspectorLoading = true;
		inspectorError = null;
		try {
			const response = await fetch(
				`/api/sessions/${encodeURIComponent(sessionKey)}/runs/${encodeURIComponent(runId)}/inspector`
			);
			if (!response.ok) throw new Error(await response.text());
			inspector = (await response.json()) as RunInspectorProjection;
		} catch (caught) {
			inspectorError = messageFromCaught(caught, 'Failed to load run inspector');
		} finally {
			inspectorLoading = false;
		}
	}

	async function loadMemory(sessionKey: string) {
		memoryLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/memory`);
			if (!response.ok) return;
			const body = (await response.json()) as {
				notes: MemoryNote[];
				candidates: MemoryCandidate[];
			};
			memoryNotes = body.notes;
			memoryCandidates = body.candidates;
		} finally {
			memoryLoading = false;
		}
	}

	async function handleApproveCandidate(candidateId: string) {
		if (!selectedSession) return;
		const sessionKey = selectedSession.sessionKey;
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(sessionKey)}/memory/candidates/${encodeURIComponent(candidateId)}`,
			{ method: 'POST' }
		);
		if (!response.ok) return;
		await loadMemory(sessionKey);
	}

	async function handleDiscardCandidate(candidateId: string) {
		if (!selectedSession) return;
		const sessionKey = selectedSession.sessionKey;
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(sessionKey)}/memory/candidates/${encodeURIComponent(candidateId)}`,
			{ method: 'DELETE' }
		);
		if (!response.ok) return;
		await loadMemory(sessionKey);
	}

	function handleEditCandidate() {
		editCandidateNotice =
			'Editing memory candidates is not yet available. Use Approve or Discard to action this candidate.';
	}

	async function loadApprovals(sessionKey: string) {
		approvalsLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/approvals`);
			if (!response.ok) return;
			const body = (await response.json()) as { approvals: ApprovalCardState[] };
			approvals = body.approvals;
		} finally {
			approvalsLoading = false;
		}
	}

	async function loadSandbox(sessionKey: string) {
		sandboxLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/sandbox`);
			if (!response.ok) return;
			const body = (await response.json()) as {
				sandbox: SandboxInfo | null;
				commands: SandboxCommandRow[];
				snapshots: SandboxSnapshotRow[];
			};
			sandboxInfo = body.sandbox;
			sandboxCmds = body.commands;
			sandboxSnaps = body.snapshots;
		} finally {
			sandboxLoading = false;
		}
	}

	async function loadWorkspace(sessionKey: string) {
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/workspace`);
			if (!response.ok) return;
			const body = (await response.json()) as {
				files: WorkspaceFile[];
				commands: WorkspaceCommand[];
				snapshots: WorkspaceSnapshot[];
				artifacts: WorkspaceArtifact[];
				diffs: WorkspaceDiff[];
			};
			workspaceFiles = body.files;
			workspaceCommands = body.commands;
			workspaceSnapshots = body.snapshots;
			workspaceArtifacts = body.artifacts;
			workspaceDiffs = body.diffs;
		} catch {
			// Non-fatal: workspace data may not be available for all sessions
		}
	}

	async function handleApprovalResolve(resolution: ApprovalResolutionInput) {
		const response = await fetch(`/api/approvals/${resolution.approvalId}/resolve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(resolution)
		});
		if (!response.ok) throw new Error(await response.text());
		if (selectedSession) {
			await loadApprovals(selectedSession.sessionKey);
		}
	}

	// ── manual inspector fallback ────────────────────────────────────────────

	async function loadRunInspectorManual() {
		const sessionKey = inspectorSessionKey.trim();
		const runId = inspectorRunId.trim();
		if (!sessionKey || !runId) {
			inspectorFormError = 'Session key and run id are required.';
			return;
		}
		inspectorFormError = null;
		await Promise.all([
			loadInspector(sessionKey, runId),
			loadMemory(sessionKey),
			loadApprovals(sessionKey),
			loadSandbox(sessionKey),
			loadWorkspace(sessionKey)
		]);
	}

	function openTemporalWeb(url: string) {
		window.open(url, '_blank', 'noreferrer');
	}

	// ── schedules ───────────────────────────────────────────────────────────

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
			schedules = schedules.filter((s) => s.temporalScheduleId !== scheduleId);
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
			(s) => s.temporalScheduleId === nextSchedule.temporalScheduleId
		);
		if (index === -1) {
			schedules = [...schedules, nextSchedule];
			return;
		}
		schedules = schedules.map((s, i) => (i === index ? nextSchedule : s));
	}

	function messageFromCaught(caught: unknown, fallback: string) {
		return caught instanceof Error && caught.message ? caught.message : fallback;
	}

	function formatDate(value: string | null) {
		return value ? new Date(value).toLocaleString() : 'None';
	}

	function formatStatus(status: string) {
		return status.replace(/_/g, ' ');
	}
</script>

<svelte:head>
	<title>Operator Console — Stardust</title>
</svelte:head>

<main class="console">
	<header class="page-header">
		<div>
			<p class="eyebrow">Stardust</p>
			<h1>Operations Console</h1>
		</div>
		<div class="header-actions">
			<SegmentedControl
				id="view-mode-control"
				label="View mode"
				hideLabel
				density="toolbar"
				value={viewMode.mode}
				onchange={(value) => {
					if (value === 'operator' || value === 'engineer') viewMode.set(value);
				}}
			>
				<Segment value="operator">Operator</Segment>
				<Segment value="engineer">Engineer</Segment>
			</SegmentedControl>
			<Button
				variant="ghost"
				size="sm"
				label="Refresh Sessions"
				onclick={loadSessions}
				disabled={sessionsLoading}
			/>
			<Button
				variant="ghost"
				size="sm"
				label="Refresh Schedules"
				onclick={loadSchedules}
				disabled={schedulesLoading}
			/>
			<Button
				variant="secondary"
				size="sm"
				label="Settings"
				onclick={() => (settingsOpen = true)}
			/>
		</div>
	</header>

	<Settings bind:open={settingsOpen} />

	<!-- ── Sessions and Run Navigation ─────────────────────────────────────── -->
	<section class="panel" aria-labelledby="sessions-heading">
		<div class="section-heading">
			<div>
				<h2 id="sessions-heading">Sessions</h2>
				<p class="muted">Select a session then a run to inspect it.</p>
			</div>
		</div>

		{#if sessionsError}
			<p class="error">{sessionsError}</p>
		{/if}

		{#if sessionsLoading}
			<p class="muted">Loading sessions...</p>
		{:else if sessions.length === 0}
			<p class="muted">No sessions found. Start a session using the turn endpoint.</p>
		{:else}
			<div class="session-list">
				{#each sessions as session (session.id)}
					<!-- Raw <button> preserved: full-width nav list item with class:selected
					     and complex inner layout; Cinder Button can't accommodate this style. -->
					<button
						type="button"
						class="session-row"
						class:selected={selectedSession?.id === session.id}
						onclick={() => void selectSession(session)}
					>
						<span class="session-key">{session.sessionKey}</span>
						<span class="session-meta">
							<span class="status-pill" data-status={session.status}>
								{formatStatus(session.status)}
							</span>
							<span class="session-date">{formatDate(session.updatedAt)}</span>
						</span>
					</button>
				{/each}
			</div>
		{/if}

		{#if selectedSession}
			<div class="runs-panel">
				<h3>Runs for {selectedSession.sessionKey}</h3>
				{#if runsLoading}
					<p class="muted">Loading runs...</p>
				{:else if sessionRuns.length === 0}
					<p class="muted">No runs found for this session.</p>
				{:else}
					<ul class="run-list">
						{#each sessionRuns as run (run.id)}
							<li>
								<!-- Raw <button> preserved: list-item layout with class:selected and
								     complex inner content; Cinder Button can't accommodate this style. -->
								<button
									type="button"
									class="run-row"
									class:selected={selectedRun?.id === run.id}
									onclick={() => void selectRun(run, selectedSession!.sessionKey)}
								>
									<code class="run-id">{run.id.slice(0, 16)}…</code>
									<span class="status-pill" data-status={run.status}>
										{formatStatus(run.status)}
									</span>
									{#if run.model}
										<span class="run-model">{run.model}</span>
									{/if}
									<span class="run-date">{formatDate(run.startedAt)}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ── Inspector Panels ───────────────────────────────────────────────── -->
	{#if inspectorLoading}
		<div class="panel">
			<p class="muted">Loading inspector...</p>
		</div>
	{:else if inspectorError}
		<div class="panel">
			<p class="error">{inspectorError}</p>
		</div>
	{:else if inspector}
		<div class="inspector-layout">
			<section class="panel">
				<RunTimeline
					projection={inspector}
					onTemporalWeb={() => openTemporalWeb(inspector!.temporalWebUrl)}
					engineerView={viewMode.isEngineer}
				/>
			</section>

			<section class="panel">
				{#if editCandidateNotice}
					<p class="notice" role="status">{editCandidateNotice}</p>
				{/if}
				{#if memoryLoading}
					<p class="muted">Loading memory...</p>
				{:else}
					<MemoryPanel
						notes={memoryNotes}
						candidates={memoryCandidates}
						onApproveCandidate={handleApproveCandidate}
						onDiscardCandidate={handleDiscardCandidate}
						onEditCandidate={handleEditCandidate}
					/>
				{/if}
			</section>

			<section class="panel">
				<WorkspacePanel
					files={workspaceFiles}
					commands={workspaceCommands}
					snapshots={workspaceSnapshots}
					artifacts={workspaceArtifacts}
					diffs={workspaceDiffs}
				/>
			</section>

			<section class="panel">
				{#if sandboxLoading}
					<p class="muted">Loading sandbox...</p>
				{:else}
					<SandboxInspector sandbox={sandboxInfo} commands={sandboxCmds} snapshots={sandboxSnaps} />
				{/if}
			</section>

			<section class="panel">
				{#if approvalsLoading}
					<p class="muted">Loading approvals...</p>
				{:else}
					<ApprovalCenter {approvals} onResolve={handleApprovalResolve} />
				{/if}
			</section>
		</div>
	{/if}

	<!-- ── Manual Inspector Fallback ──────────────────────────────────────── -->
	<section class="panel" aria-labelledby="manual-inspector-heading">
		<div class="section-heading">
			<div>
				<h2 id="manual-inspector-heading">Manual Run Inspector</h2>
				<p class="muted">Enter a session key and run ID to inspect directly.</p>
			</div>
			{#if inspector}
				<Button
					label="Temporal Web ↗"
					variant="secondary"
					size="sm"
					onclick={() => openTemporalWeb(inspector!.temporalWebUrl)}
				/>
			{/if}
		</div>

		<form
			class="inspector-form"
			onsubmit={(event) => {
				event.preventDefault();
				void loadRunInspectorManual();
			}}
		>
			<Input
				id="inspector-session-key"
				label="Session Key"
				bind:value={inspectorSessionKey}
				required
				autocomplete="off"
			/>
			<Input
				id="inspector-run-id"
				label="Run Id"
				bind:value={inspectorRunId}
				required
				autocomplete="off"
			/>
			<Button
				label={inspectorLoading ? 'Loading…' : 'Inspect Run'}
				variant="primary"
				type="submit"
				disabled={inspectorLoading}
				class="form-submit"
			/>
		</form>

		{#if inspectorFormError}
			<p class="error">{inspectorFormError}</p>
		{/if}
	</section>

	<!-- ── Create Schedule ────────────────────────────────────────────────── -->
	<section class="panel" aria-labelledby="create-schedule-heading">
		<h2 id="create-schedule-heading">Create Schedule</h2>
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
				label={saving ? 'Creating…' : 'Create Schedule'}
				variant="primary"
				type="submit"
				disabled={saving}
				class="form-submit"
			/>
		</form>
	</section>

	<!-- ── Schedules List ─────────────────────────────────────────────────── -->
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

	/* Raw <button> session/run row elements need font inheritance */
	button {
		font: inherit;
	}

	.console {
		width: min(1120px, calc(100vw - 40px));
		margin: 0 auto;
		padding: 32px 0 48px;
		display: grid;
		gap: 24px;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.header-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
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
		margin-bottom: 12px;
		font-size: 1.1rem;
	}

	.panel {
		border: 1px solid #d7dde2;
		border-radius: 8px;
		padding: 20px;
		background: #ffffff;
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

	/* Sessions navigation */
	.session-list {
		display: grid;
		gap: 6px;
	}

	.session-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		padding: 10px 14px;
		border: 1px solid #d7dde2;
		border-radius: 6px;
		background: #f9fafb;
		color: inherit;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
		text-align: left;
	}

	.session-row.selected,
	.run-row.selected {
		border-color: #174c77;
		background: #eff6ff;
	}

	.session-key {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-meta {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-shrink: 0;
	}

	.session-date,
	.run-date {
		color: #5e6f80;
		font-size: 0.78rem;
	}

	.status-pill {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
		background: color-mix(in srgb, #1d252c 10%, transparent);
	}

	.status-pill[data-status='active'],
	.status-pill[data-status='complete'] {
		background: #e6f3ed;
		color: #17603a;
	}

	.status-pill[data-status='failed'] {
		background: #fff1f1;
		color: #7b1d1d;
	}

	.status-pill[data-status='running'],
	.status-pill[data-status='waiting_approval'] {
		background: #eff6ff;
		color: #1d4ed8;
	}

	.status-pill[data-status='idle'],
	.status-pill[data-status='pending'] {
		background: #f3f4f6;
		color: #374151;
	}

	.runs-panel {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid #e7ebef;
	}

	.runs-panel h3 {
		font-size: 0.9rem;
		margin-bottom: 10px;
		color: #40505f;
	}

	.run-list {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.run-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 12px;
		border: 1px solid #d7dde2;
		border-radius: 5px;
		background: #f9fafb;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		text-align: left;
	}

	.run-id {
		font-family: ui-monospace, monospace;
		font-size: 0.8rem;
	}

	.run-model {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		color: #5e6f80;
	}

	/* Inspector panels layout */
	.inspector-layout {
		display: grid;
		gap: 16px;
	}

	/* Schedule list */
	.schedule-list {
		display: grid;
		gap: 12px;
	}

	.schedule-row {
		display: grid;
		gap: 14px;
		padding: 18px;
		border: 1px solid #d7dde2;
		border-radius: 8px;
		background: #ffffff;
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
		flex-shrink: 0;
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

	/* Forms */
	form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}

	/* .prompt-field targets the Cinder Textarea root wrapper for the schedule prompt field */
	:global(.prompt-field) {
		grid-column: 1 / -1;
	}

	.inspector-form {
		grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
		align-items: end;
	}

	/* All action buttons now use Cinder Button. Session/run row raw <button>
	   elements have their own rules (.session-row, .run-row) below. */
	:global(.form-submit) {
		justify-self: start;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* Messages */
	.error {
		border-left: 4px solid #9b2c2c;
		padding: 12px 14px;
		background: #fff1f1;
		color: #7b1d1d;
		margin: 0;
	}

	.muted {
		color: #5e6f80;
		margin: 0;
	}

	.notice {
		border-left: 4px solid #92400e;
		padding: 10px 14px;
		background: #fffbeb;
		color: #78350f;
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
	}

	@media (max-width: 760px) {
		.console {
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
	}
</style>
