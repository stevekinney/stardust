<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import Badge from '@lostgradient/cinder/badge';
	import Textarea from '@lostgradient/cinder/textarea';
	import SearchField from '@lostgradient/cinder/search-field';
	import Select from '@lostgradient/cinder/select';
	import type { SelectOption } from '@lostgradient/cinder/select';
	import type { SessionRow } from '$lib/components/session-list.svelte';
	import { viewMode } from '$lib/view-mode.svelte';

	// ── Session fetch state ────────────────────────────────────────
	let sessions = $state<SessionRow[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state<string | null>(null);

	// ── Filter state ───────────────────────────────────────────────
	let searchQuery = $state('');
	let statusFilter = $state('');

	// ── Welcome form state ─────────────────────────────────────────
	let message = $state('');

	// ── Derived ────────────────────────────────────────────────────
	const activeSessions = $derived(sessions.filter((s) => !s.archivedAt));

	const waitingCount = $derived(
		activeSessions.filter((s) => s.status === 'waiting_approval').length
	);

	const filteredSessions = $derived.by(() => {
		let result = activeSessions;

		const query = searchQuery.trim().toLowerCase();
		if (query) {
			result = result.filter((s) => {
				const label = (s.name ?? s.sessionKey).toLowerCase();
				return label.includes(query) || s.sessionKey.toLowerCase().includes(query);
			});
		}

		if (statusFilter) {
			result = result.filter((s) => s.status === statusFilter);
		}

		return result;
	});

	// ── Filter options ─────────────────────────────────────────────
	const STATUS_OPTIONS: SelectOption[] = [
		{ value: '', label: 'All statuses' },
		{ value: 'running', label: 'Running' },
		{ value: 'streaming', label: 'Streaming' },
		{ value: 'loading', label: 'Loading' },
		{ value: 'waiting_approval', label: 'Waiting approval' },
		{ value: 'disconnected', label: 'Disconnected' },
		{ value: 'recovered', label: 'Recovered' },
		{ value: 'complete', label: 'Complete' },
		{ value: 'failed', label: 'Failed' },
		{ value: 'cancelled', label: 'Cancelled' },
		{ value: 'active', label: 'Active' },
		{ value: 'idle', label: 'Idle' }
	];

	// ── Example prompts (welcome view) ─────────────────────────────
	const EXAMPLE_PROMPTS = [
		{
			icon: 'rocket',
			text: 'Deploy the latest build to staging'
		},
		{
			icon: 'test-tube',
			text: 'Run the test suite and report failures'
		},
		{
			icon: 'activity',
			text: 'Summarize recent incidents from the last 24h'
		}
	];

	// ── Lifecycle ──────────────────────────────────────────────────
	onMount(() => {
		void loadSessions();
	});

	// ── Session loading ────────────────────────────────────────────
	async function loadSessions() {
		sessionsLoading = true;
		sessionsError = null;
		try {
			const response = await fetch('/api/sessions');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { sessions: SessionRow[] };
			sessions = body.sessions;
		} catch (caught) {
			if (caught instanceof Error) {
				try {
					const parsed = JSON.parse(caught.message) as { message?: string };
					sessionsError = parsed.message ?? caught.message;
				} catch {
					sessionsError = caught.message;
				}
			} else {
				sessionsError = 'Failed to load sessions';
			}
		} finally {
			sessionsLoading = false;
		}
	}

	// ── Navigation ─────────────────────────────────────────────────
	function navigateToSession(sessionKey: string) {
		void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`));
	}

	async function handleNewSession() {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) return;
		const body = (await response.json()) as { sessionKey: string };
		void goto(resolve(`/sessions/${encodeURIComponent(body.sessionKey)}`));
	}

	// ── Display helpers ────────────────────────────────────────────
	function displayLabel(session: SessionRow): string {
		return session.name ?? session.sessionKey;
	}

	function statusDotClass(status: string): string {
		switch (status) {
			case 'complete':
			case 'recovered':
				return 'dot-success';
			case 'failed':
				return 'dot-danger';
			case 'cancelled':
				return 'dot-muted';
			case 'running':
				return 'dot-accent dot-pulse';
			case 'streaming':
			case 'loading':
				return 'dot-info dot-pulse';
			case 'waiting_approval':
			case 'disconnected':
				return 'dot-warning dot-pulse';
			case 'active':
				return 'dot-success dot-pulse';
			default:
				return 'dot-muted';
		}
	}

	function cardBorderColor(status: string): string {
		if (status === 'waiting_approval') return 'var(--cinder-warning)';
		return 'var(--cinder-border)';
	}

	// ── Welcome form handlers ──────────────────────────────────────
	async function mintSessionKey(): Promise<string> {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) throw new Error('Failed to create session');
		const body = (await response.json()) as { sessionKey: string };
		return body.sessionKey;
	}

	function handleSubmit() {
		const trimmed = message.trim();
		if (!trimmed) return;
		void mintSessionKey().then((sessionKey) => {
			const url = resolve(
				`/sessions/${encodeURIComponent(sessionKey)}?start=${encodeURIComponent(trimmed)}`
			);
			void goto(url);
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		}
	}

	function handlePromptClick(text: string) {
		message = text;
		handleSubmit();
	}
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

{#if sessionsLoading}
	<!-- ── Loading state ────────────────────────────────────────── -->
	<div class="sessions-loading" aria-busy="true" aria-label="Loading sessions">
		<span class="sessions-loading-text">Loading sessions…</span>
	</div>
{:else if sessionsError}
	<!-- ── Error state ───────────────────────────────────────────── -->
	<div class="sessions-error" role="alert">
		<p class="sessions-error-text">{sessionsError}</p>
		<Button label="Retry" variant="secondary" size="sm" onclick={() => void loadSessions()} />
	</div>
{:else if activeSessions.length > 0}
	<!-- ── Populated sessions view ──────────────────────────────── -->
	<div class="sessions">
		<div class="sessions-header">
			<div class="sessions-heading">
				<h1 class="sessions-title">Sessions</h1>
				<span class="sessions-count">
					{activeSessions.length} active{waitingCount > 0
						? ` · ${waitingCount} waiting on you`
						: ''}
				</span>
			</div>
			<span class="header-spacer"></span>
			<Button variant="primary" size="sm" label="New session" onclick={handleNewSession}>
				<span class="new-session-content">
					<!-- lucide plus -->
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
						<path d="M5 12h14" /><path d="M12 5v14" />
					</svg>
					New session
				</span>
			</Button>
		</div>

		<div class="filter-bar">
			<div class="session-search-control">
				<SearchField
					value={searchQuery}
					placeholder="Search sessions…"
					aria-label="Search sessions"
					oninput={(query) => (searchQuery = query)}
				/>
			</div>
			<div class="session-status-control">
				<Select
					id="session-status-filter"
					label="Status"
					bind:value={statusFilter}
					options={STATUS_OPTIONS}
				/>
			</div>
		</div>

		<div class="sessions-list">
			{#each filteredSessions as session (session.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="session-item"
					style="border-color: {cardBorderColor(session.status)}"
					onclick={() => navigateToSession(session.sessionKey)}
				>
					<span class="session-dot {statusDotClass(session.status)}"></span>

					<div class="session-body">
						<div class="session-name-row">
							<span class="session-name">{displayLabel(session)}</span>
							<span class="session-id">{session.sessionKey}</span>
						</div>
						{#if session.status === 'complete'}
							<div class="session-chips">
								<span class="chip chip-success">0 events lost</span>
							</div>
						{:else if session.status === 'recovered'}
							<div class="session-chips">
								<span class="chip chip-success">0 events lost</span>
								<span class="chip chip-neutral">recovered from crash</span>
							</div>
						{:else if session.status === 'failed'}
							<div class="session-chips">
								<span class="chip chip-danger">error · review run for details</span>
							</div>
						{:else if session.status === 'disconnected'}
							<div class="session-reconnect">
								<span class="reconnect-spinner" aria-hidden="true"></span>
								<span class="reconnect-text">Reconnecting…</span>
							</div>
						{/if}
					</div>

					{#if viewMode.isEngineer}
						<div class="session-eng">
							<Badge variant="neutral" mono size="sm">{session.workflowId}</Badge>
						</div>
					{/if}
				</div>
			{/each}

			{#if filteredSessions.length === 0}
				<p class="no-results">No sessions match your filters.</p>
			{/if}
		</div>
	</div>
{:else}
	<!-- ── Welcome / first-run view (no sessions yet) ───────────── -->
	<div class="welcome">
		<div class="welcome-content">
			<div class="welcome-icon">
				<!-- lucide sparkles -->
				<svg
					width="23"
					height="23"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
					/>
					<path d="M20 3v4" />
					<path d="M22 5h-4" />
					<path d="M4 17v2" />
					<path d="M5 18H3" />
				</svg>
			</div>
			<h2 class="welcome-heading">What should the agent work on?</h2>
			<p class="welcome-description">
				Describe a task. Stardust opens a session, streams its work, and pauses for your approval
				before anything risky. It runs on a durable runtime — close this tab and pick the run back
				up exactly where it was.
			</p>

			<div class="task-input">
				<Textarea
					id="home-task"
					bind:value={message}
					onkeydown={handleKeydown}
					placeholder="e.g. Refactor the auth guards in src/lib/server and run the test suite"
					rows={3}
					aria-label="Describe a task"
				/>
			</div>

			<div class="task-actions">
				<span class="spacer"></span>
				<span class="enter-hint"><span class="mono">Enter</span> to start</span>
				<Button
					label="Start session"
					variant="primary"
					size="md"
					onclick={handleSubmit}
					disabled={!message.trim()}
				>
					<span class="btn-content">
						Start session
						<!-- lucide arrow-up -->
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
							<path d="m5 12 7-7 7 7" />
							<path d="M12 19V5" />
						</svg>
					</span>
				</Button>
			</div>

			<div class="prompt-section">
				<div class="prompt-heading">Or start from</div>
				{#each EXAMPLE_PROMPTS as prompt (prompt.text)}
					<button type="button" class="prompt-card" onclick={() => handlePromptClick(prompt.text)}>
						<svg
							class="prompt-icon"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							{#if prompt.icon === 'rocket'}
								<path
									d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"
								/>
								<path
									d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"
								/>
								<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
								<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
							{:else if prompt.icon === 'test-tube'}
								<path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2" />
								<path d="M8.5 2h7" />
								<path d="M14.5 16h-5" />
							{:else if prompt.icon === 'activity'}
								<path
									d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
								/>
							{/if}
						</svg>
						<span class="prompt-text">{prompt.text}</span>
						<span class="spacer"></span>
						<!-- lucide arrow-up-right -->
						<svg
							class="prompt-arrow"
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M7 7h10v10" />
							<path d="M7 17 17 7" />
						</svg>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	/* ── Loading / error states ───────────────────────────────────── */
	.sessions-loading,
	.sessions-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 14px;
	}

	.sessions-loading-text,
	.sessions-error-text {
		font: 400 13px system-ui;
		color: var(--cinder-text-muted);
		margin: 0;
	}

	/* ── Populated sessions view ──────────────────────────────────── */
	.sessions {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.sessions-header {
		flex: none;
		padding: 20px 24px 0;
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.sessions-heading {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
	}

	.sessions-title {
		font: 650 21px/1.2 system-ui;
		letter-spacing: -0.01em;
		margin: 0;
		color: var(--cinder-text);
	}

	.sessions-count {
		font: 500 12px system-ui;
		color: var(--cinder-text-muted);
	}

	.header-spacer {
		flex: 1;
	}

	.new-session-content {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.filter-bar {
		flex: none;
		padding: 16px 24px 4px;
		display: flex;
		align-items: end;
		gap: 12px;
	}

	.session-search-control {
		flex: 1 1 18rem;
		min-width: 14rem;
	}

	.session-status-control {
		flex: 0 0 10rem;
	}

	.sessions-list {
		flex: 1;
		overflow-y: auto;
		padding: 12px 24px 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.session-item {
		border: 1px solid var(--cinder-border);
		border-radius: 12px;
		background: var(--cinder-surface);
		padding: 16px 18px;
		display: flex;
		align-items: center;
		gap: 18px;
		cursor: pointer;
		transition: border-color 0.1s ease;
	}

	.session-item:hover {
		background: var(--cinder-surface-hover);
	}

	.session-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.session-body {
		min-width: 0;
		flex: 1;
	}

	.session-name-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.session-name {
		font: 600 14.5px system-ui;
		color: var(--cinder-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-id {
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}

	.session-eng {
		flex: none;
	}

	.no-results {
		font: 400 13px system-ui;
		color: var(--cinder-text-subtle);
		text-align: center;
		padding: 32px 0;
		margin: 0;
	}

	/* dot color classes — mirror +layout.svelte ──────────────────── */
	.dot-success {
		background: var(--cinder-success);
	}

	.dot-danger {
		background: var(--cinder-danger);
	}

	.dot-accent {
		background: var(--cinder-accent);
	}

	.dot-warning {
		background: var(--cinder-warning);
	}

	.dot-info {
		background: var(--cinder-info);
	}

	.dot-muted {
		background: var(--cinder-text-disabled);
	}

	.dot-pulse {
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	/* ── State-specific affordances ──────────────────────────────────── */
	.session-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: 6px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--cinder-radius-full);
		font-family: var(--cinder-font-mono);
		font-size: 10px;
		font-weight: 600;
		border: 1px solid;
	}

	.chip-success {
		color: var(--cinder-color-success-fg);
		background: var(--cinder-color-success-bg);
		border-color: var(--cinder-color-success-border);
	}

	.chip-danger {
		color: var(--cinder-color-danger-fg);
		background: var(--cinder-color-danger-bg);
		border-color: var(--cinder-color-danger-border);
	}

	.chip-neutral {
		color: var(--cinder-text-subtle);
		background: var(--cinder-surface-inset);
		border-color: var(--cinder-border-muted);
	}

	.session-reconnect {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		padding: 4px 8px;
		border: 1px solid var(--cinder-color-warning-border);
		background: var(--cinder-color-warning-bg);
		border-radius: 6px;
		width: fit-content;
	}

	.reconnect-spinner {
		display: inline-block;
		width: 10px;
		height: 10px;
		border: 1.5px solid var(--cinder-color-warning-fg);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		flex-shrink: 0;
	}

	.reconnect-text {
		font: 500 10.5px system-ui;
		color: var(--cinder-color-warning-fg);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Welcome / first-run view ──────────────────────────────────── */
	.welcome {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 40px;
	}

	.welcome-content {
		max-width: 560px;
		width: 100%;
		text-align: center;
	}

	.welcome-icon {
		width: 48px;
		height: 48px;
		border-radius: 12px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border);
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto;
		color: var(--cinder-accent-text);
	}

	.welcome-heading {
		font: 650 24px/1.2 system-ui;
		letter-spacing: -0.01em;
		margin: 18px 0 0;
		color: var(--cinder-text);
	}

	.welcome-description {
		font: 400 14px/1.6 system-ui;
		margin: 10px 0 0;
		color: var(--cinder-text-muted);
	}

	.task-input {
		margin-top: 22px;
		text-align: left;
	}

	.task-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
	}

	.spacer {
		flex: 1;
	}

	.enter-hint {
		font: 500 11px system-ui;
		color: var(--cinder-text-subtle);
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	.btn-content {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.prompt-section {
		margin-top: 26px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.prompt-heading {
		font: 600 10px system-ui;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		text-align: left;
		color: var(--cinder-text-subtle);
	}

	.prompt-card {
		display: flex;
		align-items: center;
		gap: 11px;
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface);
		padding: 12px 14px;
		cursor: pointer;
		font: inherit;
		color: var(--cinder-text);
		text-align: left;
	}

	.prompt-card:hover {
		border-color: var(--cinder-border-strong);
		background: var(--cinder-surface-hover);
	}

	.prompt-icon {
		color: var(--cinder-accent-text);
		flex-shrink: 0;
	}

	.prompt-text {
		font: 500 13px system-ui;
	}

	.prompt-arrow {
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}
</style>
