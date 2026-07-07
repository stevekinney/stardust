<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import type { MemoryNote, MemoryCandidate } from '$lib/server/memory/memory-store';
	import type { ApprovalCardState, ApprovalResolutionInput } from '$lib/types';
	import { viewMode } from '$lib/view-mode.svelte';
	import RunTimeline from '$lib/components/run-timeline.svelte';
	import OpsSessionBrowser, {
		type OpsRunRow,
		type OpsSessionRow
	} from '$lib/components/ops-session-browser.svelte';
	import OpsManualInspector from '$lib/components/ops-manual-inspector.svelte';
	import OpsSchedulesPanel from '$lib/components/ops-schedules-panel.svelte';
	import MemoryPanel from '$lib/components/memory-panel.svelte';
	import WorkspacePanel from '$lib/components/workspace-panel.svelte';
	import type {
		WorkspaceFile,
		WorkspaceCommand,
		WorkspaceSnapshot,
		WorkspaceArtifact,
		WorkspaceDiff
	} from '$lib/components/workspace-panel.svelte';
	import SandboxInspector from '$lib/components/sandbox-inspector.svelte';
	import type {
		SandboxInfo,
		SandboxCommandRow,
		SandboxSnapshotRow
	} from '$lib/components/sandbox-inspector.svelte';
	import ApprovalCenter from '$lib/components/approval-center.svelte';

	// — session/run navigation state —
	let sessions = $state<OpsSessionRow[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state<string | null>(null);
	let selectedSession = $state<OpsSessionRow | null>(null);
	let sessionRuns = $state<OpsRunRow[]>([]);
	let runsLoading = $state(false);
	let selectedRun = $state<OpsRunRow | null>(null);

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

	onMount(() => {
		void loadSessions();
	});

	// ── session navigation ──────────────────────────────────────────────────

	async function loadSessions() {
		sessionsLoading = true;
		sessionsError = null;
		try {
			const response = await fetch('/api/sessions');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { sessions: OpsSessionRow[] };
			sessions = body.sessions;
		} catch (caught) {
			sessionsError = messageFromCaught(caught, 'Failed to load sessions');
		} finally {
			sessionsLoading = false;
		}
	}

	async function selectSession(session: OpsSessionRow) {
		selectedSession = session;
		selectedRun = null;
		inspector = null;
		sessionRuns = [];
		runsLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}/runs`);
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { runs: OpsRunRow[] };
			sessionRuns = body.runs.sort(
				(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
		} finally {
			runsLoading = false;
		}
	}

	async function selectRun(run: OpsRunRow, sessionKey: string) {
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

	async function loadRunInspectorManual(sessionKey: string, runId: string) {
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
			<Button
				variant="ghost"
				size="sm"
				label="Refresh Sessions"
				onclick={loadSessions}
				disabled={sessionsLoading}
			/>
		</div>
	</header>

	<OpsSessionBrowser
		{sessions}
		{sessionsLoading}
		{sessionsError}
		{selectedSession}
		{sessionRuns}
		{runsLoading}
		{selectedRun}
		onSelectSession={(session) => void selectSession(session)}
		onSelectRun={(run, sessionKey) => void selectRun(run, sessionKey)}
	/>

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

	<OpsManualInspector
		{inspector}
		{inspectorLoading}
		onInspect={(sessionKey, runId) => void loadRunInspectorManual(sessionKey, runId)}
		onOpenTemporalWeb={openTemporalWeb}
	/>

	<OpsSchedulesPanel />
</main>

<style>
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
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-sm);
		font-weight: 700;
		text-transform: uppercase;
	}

	h1,
	p {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 0;
		font-size: clamp(2rem, 6vw, 3.25rem);
		line-height: 1;
	}

	.panel {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		padding: 20px;
		background: var(--cinder-surface);
	}

	.inspector-layout {
		display: grid;
		gap: 16px;
	}

	.error {
		border-left: 4px solid var(--cinder-danger);
		padding: 12px 14px;
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
		margin: 0;
	}

	.muted {
		color: var(--cinder-text-subtle);
		margin: 0;
	}

	.notice {
		border-left: 4px solid var(--cinder-warning);
		padding: 10px 14px;
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
		margin: 0 0 0.75rem;
		font-size: var(--cinder-text-sm);
	}

	@media (max-width: 760px) {
		.console {
			width: min(100vw - 24px, 1120px);
			padding-top: 20px;
		}

		.page-header {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
