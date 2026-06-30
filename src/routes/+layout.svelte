<script lang="ts">
	import '@lostgradient/cinder/styles';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import Toggle from '@lostgradient/cinder/toggle';
	import Settings from '$lib/components/settings.svelte';
	import { viewMode } from '$lib/view-mode.svelte';
	import type { SessionRow } from '$lib/components/session-list.svelte';
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

			<div class="rail-scroll">
				<div class="rail-heading">
					Sessions <span class="rail-count">{activeSessions.length}</span>
				</div>

				{#if sessionsError}
					<p class="rail-message rail-error">{sessionsError}</p>
				{:else if sessionsLoading}
					<p class="rail-message">Loading…</p>
				{:else if activeSessions.length === 0}
					<p class="rail-message">No sessions yet.</p>
				{:else}
					{#each activeSessions as session (session.id)}
						<button
							type="button"
							class="session-card"
							class:selected={currentSessionKey === session.sessionKey}
							onclick={() => handleSelectSession(session)}
							aria-label="Session {displayLabel(session)}"
							aria-current={currentSessionKey === session.sessionKey ? 'true' : undefined}
						>
							<span
								class="status-dot {statusDotClass(session.status)}"
								aria-label={formatStatus(session.status)}
							></span>
							<div class="card-content">
								<span class="card-label">{displayLabel(session)}</span>
								<span class="card-meta"
									>{session.sessionKey} · {formatStatus(session.status)} · {relativeTime(
										session.updatedAt
									)}</span
								>
							</div>
						</button>
					{/each}
				{/if}

				<div class="rail-heading" style="margin-top: 18px;">Global</div>

				<a
					href={resolve('/approvals')}
					class="rail-nav-item"
					aria-current={$page.url.pathname === '/approvals' ? 'page' : undefined}
				>
					<!-- shield-alert -->
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
						/><path d="M12 8v4" /><path d="M12 16h.01" /></svg
					>
					<span>Approvals</span>
				</a>
				<a
					href={resolve('/schedules')}
					class="rail-nav-item"
					aria-current={$page.url.pathname === '/schedules' ? 'page' : undefined}
				>
					<!-- calendar-clock -->
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" /><path
							d="M16 2v4"
						/><path d="M8 2v4" /><path d="M3 10h5" /><path d="M17.5 17.5 16 16.3V14" /><circle
							cx="16"
							cy="16"
							r="6"
						/></svg
					>
					<span>Schedules</span>
				</a>
				<a
					href={resolve('/memory')}
					class="rail-nav-item"
					aria-current={$page.url.pathname === '/memory' ? 'page' : undefined}
				>
					<!-- brain -->
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"
						/><path
							d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"
						/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" /><path
							d="M17.599 6.5a3 3 0 0 0 .399-1.375"
						/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" /><path
							d="M3.477 10.896a4 4 0 0 1 .585-.396"
						/><path d="M19.938 10.5a4 4 0 0 1 .585.396" /><path
							d="M6 18a4 4 0 0 1-1.967-.516"
						/><path d="M19.967 17.484A4 4 0 0 1 18 18" /></svg
					>
					<span>Memory</span>
				</a>
				<a
					href={resolve('/settings')}
					class="rail-nav-item"
					aria-current={$page.url.pathname === '/settings' ? 'page' : undefined}
				>
					<!-- settings -->
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
						/><circle cx="12" cy="12" r="3" /></svg
					>
					<span>Settings</span>
				</a>
			</div>

			<div class="rail-footer">
				<span class="temporal-dot"></span>
				<div class="temporal-info">
					<span class="temporal-name">Temporal dev server</span>
					<span class="temporal-detail">localhost:7776 · default namespace</span>
				</div>
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

	.rail-scroll {
		flex: 1;
		overflow-y: auto;
		padding: 0 8px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.rail-heading {
		padding: 10px 10px 6px;
		font-size: 11px;
		font-weight: 600;
		color: var(--cinder-text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.rail-count {
		font-family: var(--cinder-font-mono);
		font-size: 9px;
		color: var(--cinder-text-disabled);
	}

	.session-card {
		display: flex;
		align-items: flex-start;
		gap: 8px;
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

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 5px;
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

	.card-content {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.card-label {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-meta {
		font-size: 10.5px;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Rail nav items ──────────────────────────────────────── */
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
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.temporal-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cinder-success);
		flex-shrink: 0;
	}

	.temporal-info {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}

	.temporal-name {
		font-size: 11px;
		font-weight: 600;
		color: var(--cinder-text);
	}

	.temporal-detail {
		font-size: 9.5px;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
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

		.rail-scroll {
			padding: 4px;
		}

		.rail-heading,
		.rail-message,
		.card-content,
		.rail-nav-item span,
		.temporal-info {
			display: none;
		}

		.session-card {
			padding: 8px;
			justify-content: center;
		}

		.status-dot {
			margin-top: 0;
		}

		.rail-nav-item {
			justify-content: center;
			padding: 8px;
		}

		.rail-footer {
			padding: 10px 0;
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

		.rail.rail-open .rail-heading,
		.rail.rail-open .rail-message,
		.rail.rail-open .card-content,
		.rail.rail-open .rail-nav-item span,
		.rail.rail-open .temporal-info {
			display: revert;
		}

		.rail.rail-open .session-card {
			padding: 8px 10px;
			justify-content: flex-start;
		}

		.rail.rail-open .status-dot {
			margin-top: 5px;
		}

		.rail.rail-open .rail-nav-item {
			justify-content: flex-start;
			padding: 8px 10px;
		}

		.rail.rail-open .rail-top {
			padding: 12px;
		}

		.rail.rail-open .rail-scroll {
			padding: 0 8px;
		}

		.rail.rail-open .rail-footer {
			padding: 10px 12px;
			justify-content: flex-start;
		}

		.top {
			gap: 8px;
			padding: 0 10px;
		}
	}
</style>
