<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
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

			// Landing screen: navigate to the most recent session if one exists.
			if (sessions.length > 0) {
				const recent = sessions[0];
				void goto(resolve(`/sessions/${encodeURIComponent(recent.sessionKey)}`));
			}
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
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

<div class="home" aria-label="Stardust home">
	<header class="home-header">
		<span class="brand-name">Stardust</span>
		<nav class="home-nav">
			<a href={resolve('/ops')} class="nav-link">Operator Console</a>
		</nav>
	</header>

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

	.home-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 24px;
		border-bottom: 1px solid #d7dde2;
		background: #ffffff;
	}

	.brand-name {
		font-size: 1.1rem;
		font-weight: 900;
		color: #174c77;
		letter-spacing: -0.02em;
	}

	.home-nav {
		display: flex;
		gap: 16px;
	}

	.nav-link {
		color: #5e6f80;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.nav-link:hover {
		color: #174c77;
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
