<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import NavigationBar from '@lostgradient/cinder/navigation-bar';
	import NavigationItem from '@lostgradient/cinder/navigation-item';
	import SessionList, { type SessionRow } from '$lib/components/SessionList.svelte';
	import Composer from '$lib/components/Composer.svelte';

	let sessions = $state<SessionRow[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		void loadSessions();
	});

	async function loadSessions() {
		loading = true;
		error = null;
		try {
			const response = await fetch('/api/sessions');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { sessions: SessionRow[] };
			sessions = body.sessions;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to load sessions';
		} finally {
			loading = false;
		}
	}

	function handleSelectSession(session: SessionRow) {
		void goto(resolve(`/sessions/${encodeURIComponent(session.sessionKey)}`));
	}

	async function mintSessionKey(): Promise<string> {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) throw new Error('Failed to create session');
		const body = (await response.json()) as { sessionKey: string };
		return body.sessionKey;
	}

	function handleCreateSession() {
		// Request a server-minted session key so the browser never decides the key.
		void mintSessionKey().then((sessionKey) => {
			void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`));
		});
	}

	function handleHomeSubmit(message: string) {
		// Request a server-minted session key, then navigate to the conversation
		// page with the first message pre-loaded so it auto-submits the first turn.
		void mintSessionKey().then((sessionKey) => {
			const url = resolve(
				`/sessions/${encodeURIComponent(sessionKey)}?start=${encodeURIComponent(message)}`
			);
			void goto(url);
		});
	}

	async function handleRenameSession(session: SessionRow) {
		const current = session.name ?? session.sessionKey;
		const name = window.prompt('Rename session', current);
		if (!name || !name.trim()) return;

		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() })
			});
			if (!response.ok) throw new Error(await response.text());
			// Reload the list so the updated name is reflected.
			await loadSessions();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to rename session';
		}
	}

	async function handleArchiveSession(session: SessionRow) {
		const confirmed = window.confirm(
			`Archive session "${session.name ?? session.sessionKey}"? It will be hidden from the list.`
		);
		if (!confirmed) return;

		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived: true })
			});
			if (!response.ok) throw new Error(await response.text());
			// Reload the list; archived session will be excluded by the API.
			await loadSessions();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to archive session';
		}
	}
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

<div class="home" aria-label="Stardust home">
	<NavigationBar label="Stardust navigation">
		{#snippet brand()}
			<span class="brand-name">Stardust</span>
		{/snippet}
		{#snippet items()}
			<NavigationItem href={resolve('/ops')}>Operator Console</NavigationItem>
		{/snippet}
	</NavigationBar>

	<main class="home-main">
		{#if loading}
			<div class="loading-state">
				<p class="muted">Loading…</p>
			</div>
		{:else}
			<div class="home-layout">
				<aside class="sessions-sidebar" aria-label="Session navigation">
					<SessionList
						{sessions}
						{loading}
						{error}
						onSelect={handleSelectSession}
						onCreate={handleCreateSession}
						onRename={handleRenameSession}
						onArchive={handleArchiveSession}
					/>
				</aside>

				<section class="welcome-area" aria-label="Start a conversation">
					<div class="welcome-content">
						<h1 class="welcome-heading">What can I help you with?</h1>
						<p class="welcome-subtitle">
							Start a new conversation or select a session from the sidebar.
						</p>
						<div class="start-composer">
							<Composer onSubmit={handleHomeSubmit} />
						</div>
					</div>
				</section>
			</div>
		{/if}
	</main>
</div>

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

	.home {
		display: grid;
		grid-template-rows: auto 1fr;
		height: 100dvh;
		overflow: hidden;
	}

	.brand-name {
		font-size: 1.1rem;
		font-weight: 900;
		color: #174c77;
		letter-spacing: -0.02em;
	}

	.home-main {
		overflow: hidden;
	}

	.loading-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
	}

	.home-layout {
		display: grid;
		grid-template-columns: 300px 1fr;
		height: 100%;
		overflow: hidden;
	}

	.sessions-sidebar {
		border-right: 1px solid #d7dde2;
		background: #f9fafb;
		padding: 16px;
		overflow-y: auto;
	}

	.welcome-area {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px;
		background: #ffffff;
	}

	.welcome-content {
		max-width: 600px;
		width: 100%;
	}

	.welcome-heading {
		margin: 0 0 8px;
		font-size: clamp(1.5rem, 4vw, 2.25rem);
		font-weight: 900;
		color: #1d252c;
		line-height: 1.1;
	}

	.welcome-subtitle {
		margin: 0 0 28px;
		color: #5e6f80;
		font-size: 1rem;
	}

	.start-composer {
		border: 1px solid #d7dde2;
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.06);
	}

	.muted {
		color: #5e6f80;
	}

	@media (max-width: 700px) {
		.home-layout {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr;
		}

		.sessions-sidebar {
			border-right: none;
			border-bottom: 1px solid #d7dde2;
			max-height: 200px;
		}
	}
</style>
