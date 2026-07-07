<script lang="ts" module>
	export type OpsSessionRow = {
		id: string;
		sessionKey: string;
		status: string;
		workflowId: string;
		createdAt: string;
		updatedAt: string;
	};

	export type OpsRunRow = {
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
</script>

<script lang="ts">
	import ActionRow from '@lostgradient/cinder/action-row';

	type Props = {
		sessions: OpsSessionRow[];
		sessionsLoading: boolean;
		sessionsError: string | null;
		selectedSession: OpsSessionRow | null;
		sessionRuns: OpsRunRow[];
		runsLoading: boolean;
		selectedRun: OpsRunRow | null;
		onSelectSession: (session: OpsSessionRow) => void;
		onSelectRun: (run: OpsRunRow, sessionKey: string) => void;
	};

	let {
		sessions,
		sessionsLoading,
		sessionsError,
		selectedSession,
		sessionRuns,
		runsLoading,
		selectedRun,
		onSelectSession,
		onSelectRun
	}: Props = $props();

	function formatDate(value: string | null) {
		return value ? new Date(value).toLocaleString() : 'None';
	}

	function formatStatus(status: string) {
		return status.replace(/_/g, ' ');
	}
</script>

<section class="panel" aria-labelledby="sessions-heading">
	<div class="section-heading">
		<div>
			<h2 id="sessions-heading">Sessions</h2>
			<p class="muted">Select a session then a run to inspect it.</p>
		</div>
	</div>

	{#if sessionsError}
		<p class="error">{sessionsError}</p>
	{:else if sessionsLoading}
		<p class="muted">Loading sessions...</p>
	{:else if sessions.length === 0}
		<p class="muted">No sessions found. Start a session using the turn endpoint.</p>
	{:else}
		<div class="session-list">
			{#each sessions as session (session.id)}
				<ActionRow
					density="condensed"
					selected={selectedSession?.id === session.id}
					selectedState="current"
					onclick={() => onSelectSession(session)}
				>
					{#snippet title()}
						<span class="session-key">{session.sessionKey}</span>
					{/snippet}
					{#snippet trailing()}
						<span class="session-meta">
							<span class="status-pill" data-status={session.status}>
								{formatStatus(session.status)}
							</span>
							<span class="session-date">{formatDate(session.updatedAt)}</span>
						</span>
					{/snippet}
				</ActionRow>
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
							<ActionRow
								density="condensed"
								selected={selectedRun?.id === run.id}
								selectedState="current"
								onclick={() => onSelectRun(run, selectedSession.sessionKey)}
							>
								{#snippet title()}
									<code class="run-id">{run.id.slice(0, 16)}...</code>
								{/snippet}
								{#snippet meta()}
									<span class="status-pill" data-status={run.status}>
										{formatStatus(run.status)}
									</span>
									{#if run.model}
										<span class="run-model">{run.model}</span>
									{/if}
								{/snippet}
								{#snippet trailing()}
									<span class="run-date">{formatDate(run.startedAt)}</span>
								{/snippet}
							</ActionRow>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<style>
	.panel {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		padding: 20px;
		background: var(--cinder-surface);
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

	.session-list {
		display: grid;
		gap: 6px;
	}

	.session-key {
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-sm);
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
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
	}

	.status-pill {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: var(--cinder-radius-full);
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-2xs);
		font-weight: 700;
		text-transform: capitalize;
	}

	.status-pill[data-status='active'],
	.status-pill[data-status='complete'] {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-pill[data-status='failed'] {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.status-pill[data-status='running'],
	.status-pill[data-status='waiting_approval'] {
		background: var(--cinder-color-info-bg);
		color: var(--cinder-color-info-fg);
	}

	.status-pill[data-status='idle'],
	.status-pill[data-status='pending'] {
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.runs-panel {
		margin-top: 16px;
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 16px;
	}

	.runs-panel h3 {
		margin-bottom: 10px;
		color: var(--cinder-text-muted);
		font-size: var(--cinder-text-sm);
	}

	.run-list {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.run-id {
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-xs);
	}

	.run-model {
		color: var(--cinder-text-subtle);
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-xs);
	}

	.error {
		border-left: 4px solid var(--cinder-danger);
		margin: 0;
		padding: 12px 14px;
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.muted {
		margin: 0;
		color: var(--cinder-text-subtle);
	}

	@media (max-width: 760px) {
		.section-heading {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
