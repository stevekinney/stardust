<script lang="ts">
	import '@lostgradient/cinder/styles';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import Toggle from '@lostgradient/cinder/toggle';
	import Settings from '$lib/components/Settings.svelte';
	import { viewMode } from '$lib/view-mode.svelte';
	import type { SessionRow } from '$lib/components/SessionList.svelte';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	let sessions = $state<SessionRow[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state<string | null>(null);
	let settingsOpen = $state(false);
	let railOpen = $state(false);

	const currentSessionKey = $derived($page.params.sessionKey ?? null);

	const activeSessions = $derived(sessions.filter((s) => !s.archivedAt));

	onMount(() => {
		document.documentElement.setAttribute('data-theme', 'dark');
		void loadSessions();
	});

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

	function handleSelectSession(session: SessionRow) {
		railOpen = false;
		void goto(resolve(`/sessions/${encodeURIComponent(session.sessionKey)}`));
	}

	async function handleCreateSession() {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) return;
		const body = (await response.json()) as { sessionKey: string };
		void goto(resolve(`/sessions/${encodeURIComponent(body.sessionKey)}`));
	}

	function displayLabel(session: SessionRow): string {
		return session.name ?? session.sessionKey;
	}

	function formatStatus(status: string) {
		return status.replace(/_/g, ' ');
	}

	function statusDotClass(status: string): string {
		switch (status) {
			case 'complete':
				return 'dot-success';
			case 'failed':
				return 'dot-danger';
			case 'cancelled':
				return 'dot-warning';
			case 'running':
			case 'streaming':
			case 'loading':
				return 'dot-accent dot-pulse';
			case 'waiting_approval':
				return 'dot-warning dot-pulse';
			case 'recovered':
				return 'dot-info';
			case 'disconnected':
				return 'dot-danger dot-pulse';
			case 'active':
				return 'dot-success dot-pulse';
			default:
				return 'dot-muted';
		}
	}

	function relativeTime(dateString: string): string {
		const now = Date.now();
		const then = new Date(dateString).getTime();
		const seconds = Math.floor((now - then) / 1000);
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app">
	<!-- Top bar -->
	<header class="top">
		<button
			type="button"
			class="rail-toggle icon-button"
			aria-label="Toggle navigation"
			onclick={() => (railOpen = !railOpen)}
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line
					x1="3"
					y1="18"
					x2="21"
					y2="18"
				/>
			</svg>
		</button>
		<a href={resolve('/')} class="brand" aria-label="Stardust home">
			<span class="brand-name">STARDUST</span>
		</a>

		<span class="vr" aria-hidden="true"></span>

		{#if currentSessionKey}
			<span class="session-chip">
				<span class="chip-dot"></span>
				<span class="chip-label">{currentSessionKey}</span>
			</span>
		{/if}

		<div class="top-spacer"></div>

		<div class="worker-status">
			<span class="worker-dot"></span>
			<b class="worker-label">Worker · live</b>
		</div>

		<div class="uth">
			<div class="uth-label">
				<b>Under the hood</b>
				<span>Show Temporal internals</span>
			</div>
			<Toggle
				id="view-mode-toggle"
				label="Under the hood"
				hideLabel
				checked={viewMode.mode === 'engineer'}
				onValueChange={(next) => {
					viewMode.set(next ? 'engineer' : 'operator');
				}}
			/>
		</div>

		<button
			type="button"
			class="icon-button"
			aria-label="Settings"
			onclick={() => (settingsOpen = true)}
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path
					d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
				/>
				<circle cx="12" cy="12" r="3" />
			</svg>
		</button>
	</header>

	<div class="body">
		{#if railOpen}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="rail-backdrop" onclick={() => (railOpen = false)}></div>
		{/if}

		<!-- Left rail -->
		<nav class="rail" class:rail-open={railOpen} aria-label="Session navigation">
			<div class="rail-top">
				<Button
					label="New Session"
					variant="primary"
					size="sm"
					onclick={handleCreateSession}
					class="new-session-button"
				/>
			</div>

			<div class="rail-sessions">
				{#if sessionsError}
					<p class="rail-message rail-error">{sessionsError}</p>
				{:else if sessionsLoading}
					<p class="rail-message">Loading…</p>
				{:else if activeSessions.length === 0}
					<p class="rail-message">No sessions yet.</p>
				{:else}
					<ul class="session-list" role="list">
						{#each activeSessions as session (session.id)}
							<li>
								<button
									type="button"
									class="session-card"
									class:selected={currentSessionKey === session.sessionKey}
									onclick={() => handleSelectSession(session)}
									aria-label="Session {displayLabel(session)}"
									aria-current={currentSessionKey === session.sessionKey ? 'true' : undefined}
								>
									<span class="card-top-row">
										<span
											class="status-dot {statusDotClass(session.status)}"
											aria-label={formatStatus(session.status)}
										></span>
										<span class="card-label">{displayLabel(session)}</span>
									</span>
									<span class="card-meta">
										<span class="card-status">{formatStatus(session.status)}</span>
										<span class="card-time">{relativeTime(session.updatedAt)}</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rail-nav">
				<a
					href={resolve('/ops')}
					class="rail-nav-item"
					aria-current={$page.url.pathname === '/ops' ? 'page' : undefined}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<rect width="7" height="9" x="3" y="3" rx="1" /><rect
							width="7"
							height="5"
							x="14"
							y="3"
							rx="1"
						/><rect width="7" height="9" x="14" y="12" rx="1" /><rect
							width="7"
							height="5"
							x="3"
							y="16"
							rx="1"
						/>
					</svg>
					<span>Operations</span>
				</a>
			</div>

			<div class="rail-footer">
				<span class="temporal-status">
					<span class="temporal-dot"></span>
					<span>Temporal Server</span>
				</span>
			</div>
		</nav>

		<!-- Main content area -->
		<main class="main">
			{@render children()}
		</main>
	</div>
</div>

<Settings bind:open={settingsOpen} />

<style>
	:global(html) {
		color-scheme: dark;
	}

	:global(body) {
		margin: 0;
		background: var(--cinder-bg);
		color: var(--cinder-text);
		font-family: var(--cinder-font-sans);
		font-size: var(--cinder-text-base);
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		background: var(--cinder-bg);
	}

	/* ── Top bar ─────────────────────────────────────────────── */
	.top {
		height: 52px;
		flex: none;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 0 14px;
		border-bottom: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
	}

	.brand {
		display: flex;
		align-items: center;
		text-decoration: none;
		color: var(--cinder-text);
	}

	.brand-name {
		font-size: 12.5px;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--cinder-text);
	}

	.vr {
		width: 1px;
		height: 20px;
		background: var(--cinder-border);
		flex-shrink: 0;
	}

	.session-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: var(--cinder-radius-full);
		background: var(--cinder-surface-inset);
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-muted);
		max-width: 200px;
		overflow: hidden;
	}

	.chip-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cinder-success);
		flex-shrink: 0;
	}

	.chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.top-spacer {
		flex: 1;
	}

	.worker-status {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 4px 10px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-full);
		background: var(--cinder-surface-raised);
		font-size: 11px;
		white-space: nowrap;
	}

	.worker-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--cinder-success);
		flex-shrink: 0;
	}

	.worker-label {
		font-weight: 600;
		color: var(--cinder-text);
	}

	.uth {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.uth-label {
		display: flex;
		flex-direction: column;
		text-align: right;
		line-height: 1.2;
	}

	.uth-label b {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--cinder-text);
	}

	.uth-label span {
		font-size: 10px;
		color: var(--cinder-text-subtle);
	}

	.icon-button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		border-radius: var(--cinder-radius-md);
		background: transparent;
		color: var(--cinder-text-subtle);
		cursor: pointer;
	}

	.icon-button:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	/* ── Body (rail + main) ──────────────────────────────────── */
	.body {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	/* ── Left rail ───────────────────────────────────────────── */
	.rail {
		width: 236px;
		flex: none;
		border-right: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.rail-top {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
	}

	:global(.new-session-button) {
		width: 100%;
	}

	.rail-sessions {
		flex: 1;
		overflow-y: auto;
		padding: 0 8px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.session-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.session-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid transparent;
		border-radius: var(--cinder-radius-md);
		background: transparent;
		color: var(--cinder-text);
		font: inherit;
		font-size: var(--cinder-text-sm);
		cursor: pointer;
		text-align: left;
	}

	.session-card:hover {
		background: var(--cinder-surface-hover);
	}

	.session-card.selected {
		background: var(--cinder-surface-raised);
		border-color: var(--cinder-border-muted);
	}

	.card-top-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

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

	.card-label {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-meta {
		display: flex;
		justify-content: space-between;
		padding-left: 15px;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
	}

	.card-status {
		text-transform: capitalize;
	}

	/* ── Rail nav ────────────────────────────────────────────── */
	.rail-nav {
		border-top: 1px solid var(--cinder-border-muted);
		padding: 8px;
	}

	.rail-nav-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: var(--cinder-radius-md);
		color: var(--cinder-text-subtle);
		text-decoration: none;
		font-size: var(--cinder-text-sm);
	}

	.rail-nav-item:hover {
		color: var(--cinder-text);
		background: var(--cinder-surface-hover);
	}

	.rail-nav-item[aria-current='page'] {
		color: var(--cinder-text);
		background: var(--cinder-surface-raised);
	}

	/* ── Rail footer ─────────────────────────────────────────── */
	.rail-footer {
		border-top: 1px solid var(--cinder-border-muted);
		padding: 10px 12px;
	}

	.temporal-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
	}

	.temporal-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cinder-success);
	}

	/* ── Main content ────────────────────────────────────────── */
	.main {
		flex: 1;
		overflow: auto;
		background: var(--cinder-bg);
	}

	.rail-message {
		padding: 8px 10px;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
		margin: 0;
	}

	.rail-error {
		color: var(--cinder-color-danger-fg);
	}

	/* ── Rail toggle (hidden on desktop) ─────────────────── */
	.rail-toggle {
		display: none;
	}

	/* ── Backdrop overlay for mobile rail ────────────────── */
	.rail-backdrop {
		display: none;
	}

	/* ── Tablet: collapsed icon-only rail ────────────────── */
	@media (max-width: 1024px) {
		.rail {
			width: 56px;
			overflow: hidden;
		}

		.rail-top {
			display: none;
		}

		.rail-sessions {
			padding: 4px;
		}

		.rail-message {
			display: none;
		}

		.session-card {
			padding: 8px;
			justify-content: center;
		}

		.card-top-row {
			justify-content: center;
		}

		.card-label,
		.card-meta,
		.rail-nav-item span,
		.rail-footer span:not(.temporal-dot) {
			display: none;
		}

		.rail-nav-item {
			justify-content: center;
			padding: 8px;
		}

		.rail-footer {
			padding: 10px 0;
			display: flex;
			justify-content: center;
		}

		.temporal-status {
			justify-content: center;
		}

		.brand-name {
			display: none;
		}

		.vr {
			display: none;
		}

		.session-chip {
			display: none;
		}

		.worker-status {
			padding: 4px 7px;
		}

		.worker-label {
			display: none;
		}

		.uth-label {
			display: none;
		}

		.rail-toggle {
			display: flex;
		}
	}

	/* ── Phone: hidden rail with overlay ─────────────────── */
	@media (max-width: 640px) {
		.rail {
			position: fixed;
			top: 0;
			left: 0;
			bottom: 0;
			z-index: 100;
			width: 280px;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}

		.rail.rail-open {
			transform: translateX(0);
		}

		.rail-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 99;
			background: oklch(0% 0 0 / 0.5);
		}

		/* Restore full rail content when open on phone */
		.rail.rail-open .rail-top {
			display: flex;
		}

		.rail.rail-open .rail-message {
			display: block;
		}

		.rail.rail-open .card-label,
		.rail.rail-open .card-meta,
		.rail.rail-open .rail-nav-item span,
		.rail.rail-open .rail-footer span:not(.temporal-dot) {
			display: revert;
		}

		.rail.rail-open .session-card {
			padding: 8px 10px;
			justify-content: flex-start;
		}

		.rail.rail-open .card-top-row {
			justify-content: flex-start;
		}

		.rail.rail-open .rail-nav-item {
			justify-content: flex-start;
			padding: 8px 10px;
		}

		.rail.rail-open .rail-top {
			padding: 12px;
		}

		.rail.rail-open .rail-sessions {
			padding: 0 8px;
		}

		.rail.rail-open .rail-footer {
			padding: 10px 12px;
			justify-content: flex-start;
		}

		.rail.rail-open .temporal-status {
			justify-content: flex-start;
		}

		.top {
			gap: 8px;
			padding: 0 10px;
		}
	}
</style>
