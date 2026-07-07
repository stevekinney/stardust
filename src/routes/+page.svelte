<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import FacetedFilterBar, {
		type AppliedFilter,
		type FacetDefinition
	} from '@lostgradient/cinder/faceted-filter-bar';
	import Textarea from '@lostgradient/cinder/textarea';
	import SessionRowCard, { sessionTone } from '$lib/components/session-row.svelte';
	import { sessionsStore } from '$lib/sessions.svelte';
	import type { SessionRow } from '$lib/types';

	type SessionFilter = 'all' | 'running' | 'needs-you' | 'complete';

	let filter = $state<SessionFilter>('all');
	let message = $state('');

	const activeSessions = $derived(sessionsStore.active);

	const counts = $derived({
		all: activeSessions.length,
		running: activeSessions.filter((s) => sessionTone(s.status) === 'running').length,
		'needs-you': activeSessions.filter((s) => sessionTone(s.status) === 'needs-you').length,
		complete: activeSessions.filter((s) => sessionTone(s.status) === 'done').length
	});

	const filteredSessions = $derived.by(() => {
		if (filter === 'running') {
			return activeSessions.filter((s) => sessionTone(s.status) === 'running');
		}
		if (filter === 'needs-you') {
			return activeSessions.filter((s) => sessionTone(s.status) === 'needs-you');
		}
		if (filter === 'complete') {
			return activeSessions.filter((s) => sessionTone(s.status) === 'done');
		}
		return activeSessions;
	});

	const filterOptions = $derived([
		{ value: 'all', label: `All ${counts.all}` },
		{ value: 'running', label: `Running ${counts.running}` },
		{ value: 'needs-you', label: `Needs you ${counts['needs-you']}` },
		{ value: 'complete', label: `Complete ${counts.complete}` }
	]);

	const sessionFilterFacets = $derived<FacetDefinition[]>([
		{
			type: 'select',
			key: 'status',
			label: 'Status',
			options: filterOptions
		}
	]);

	const appliedSessionFilters = $derived<AppliedFilter[]>(
		filter === 'all'
			? []
			: [
					{
						key: 'status',
						value: filter,
						label: filterOptions.find((option) => option.value === filter)?.label ?? filter
					}
				]
	);

	const CONCEPT_MAP = [
		{ app: 'Session', temporal: 'Workflow' },
		{ app: 'Turn', temporal: 'Child workflow' },
		{ app: 'Tool call', temporal: 'Activity' },
		{ app: 'Approval', temporal: 'Signal + wait' },
		{ app: 'Schedule', temporal: 'Schedule' }
	];

	const STARTER_TASKS = [
		{
			kicker: 'Try the basics',
			title: 'Write a file to the workspace',
			body: 'One tool call, one activity, one durable event history you can open in Temporal Web.',
			prompt:
				"Create a file at notes/hello.txt in the workspace containing the text 'Hello from Stardust'."
		},
		{
			kicker: 'The headline trick',
			title: 'Prove durability — kill the worker mid-run',
			body: 'Start a long task, kill the worker process, and watch the run resume on a survivor.',
			prompt:
				'Check the overnight CI runs, figure out what broke, and draft a summary for the team.'
		},
		{
			kicker: 'Fan out',
			title: 'Research three topics in parallel',
			body: 'Each delegate is a child workflow with its own history, budget, and retry policy.',
			prompt:
				'Research three topics in parallel: Temporal schedules, child workflows, and activity retries. Summarize each.'
		},
		{
			kicker: 'Set and forget',
			title: 'Schedule a morning digest',
			body: 'A native Temporal Schedule that fires at 6:00 AM whether or not this app is open.',
			prompt: null
		}
	];

	onMount(() => {
		void sessionsStore.load();
	});

	function openSession(session: SessionRow) {
		void goto(resolve(`/sessions/${encodeURIComponent(session.sessionKey)}`));
	}

	async function renameSession(session: SessionRow, name: string) {
		try {
			await sessionsStore.rename(session.sessionKey, name);
		} catch {
			// Non-fatal — the row keeps its previous name and the user can retry.
		}
	}

	async function mintSessionKey(): Promise<string> {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) throw new Error('Failed to create session');
		const body = (await response.json()) as { sessionKey: string };
		return body.sessionKey;
	}

	async function handleNewSession() {
		const sessionKey = await mintSessionKey();
		void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}?fresh=1`));
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

	function handleStarterTask(task: (typeof STARTER_TASKS)[number]) {
		if (task.prompt === null) {
			void goto(resolve('/schedules'));
			return;
		}
		message = task.prompt;
		handleSubmit();
	}

	function handleSessionFilterChange(key: string, value: string) {
		if (key !== 'status') return;
		filter = (value || 'all') as SessionFilter;
	}
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

{#if sessionsStore.loading && sessionsStore.sessions.length === 0}
	<div class="state-screen" aria-busy="true" aria-label="Loading sessions">
		<span class="state-text">Loading sessions…</span>
	</div>
{:else if sessionsStore.error}
	<div class="state-screen" role="alert">
		<p class="state-text">{sessionsStore.error}</p>
		<Button label="Retry" variant="secondary" size="sm" onclick={() => void sessionsStore.load()} />
	</div>
{:else if activeSessions.length > 0}
	<!-- ── Sessions list ────────────────────────────────────────── -->
	<div class="page">
		<div class="page-head">
			<h1 class="page-title">Sessions</h1>
			<span class="spacer"></span>
			<Button variant="primary" size="sm" label="New session" onclick={handleNewSession} />
		</div>

		<FacetedFilterBar
			aria-label="Filter sessions"
			facets={sessionFilterFacets}
			appliedFilters={appliedSessionFilters}
			onfacetchange={handleSessionFilterChange}
			onfilterremove={() => (filter = 'all')}
			onclearall={() => (filter = 'all')}
		/>

		<div class="session-rows">
			{#each filteredSessions as session (session.id)}
				<SessionRowCard {session} onOpen={openSession} onRename={renameSession} />
			{/each}
			{#if filteredSessions.length === 0}
				<p class="no-results">No sessions match this filter.</p>
			{/if}
		</div>
	</div>
{:else}
	<!-- ── First-run empty state ────────────────────────────────── -->
	<div class="first-run">
		<div class="hero">
			<span class="hero-kicker">STARDUST</span>
			<h1 class="hero-title">Your agent, crash-proof.</h1>
			<p class="hero-description">
				Every conversation is a durable Temporal Workflow. Kill the tab, kill the worker, kill the
				laptop — the run picks up exactly where it left off.
			</p>
		</div>

		<div class="composer">
			<Textarea
				id="home-task"
				bind:value={message}
				onkeydown={handleKeydown}
				placeholder="e.g. Refactor the auth guards in src/lib/server and run the test suite"
				rows={3}
				aria-label="Describe a task"
			/>
			<div class="composer-actions">
				<span class="spacer"></span>
				<span class="enter-hint"><span class="mono">Enter</span> to start</span>
				<Button
					label="Start session"
					variant="primary"
					size="md"
					onclick={handleSubmit}
					disabled={!message.trim()}
				/>
			</div>
		</div>

		<div class="starter-grid">
			{#each STARTER_TASKS as task (task.title)}
				<button type="button" class="starter-card" onclick={() => handleStarterTask(task)}>
					<span class="starter-kicker">{task.kicker}</span>
					<span class="starter-title">{task.title}</span>
					<span class="starter-body">{task.body}</span>
				</button>
			{/each}
		</div>

		<div class="concept-card">
			<div class="concept-head">
				<h2 class="concept-title">How Stardust maps to Temporal</h2>
				<span class="spacer"></span>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
				<a class="concept-link" href="http://localhost:8233" target="_blank" rel="noreferrer">
					Open Temporal Web ↗
				</a>
			</div>
			<div class="concept-grid">
				{#each CONCEPT_MAP as concept (concept.app)}
					<div class="concept-cell">
						<span class="concept-app">{concept.app}</span>
						<span class="concept-temporal">{concept.temporal}</span>
					</div>
				{/each}
			</div>
			<p class="concept-footnote">
				Runs locally: Temporal dev server, one worker, SQLite, and your Anthropic key. No other
				accounts, no other API keys.
			</p>
		</div>
	</div>
{/if}

<style>
	.state-screen {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 14px;
	}

	.state-text {
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-muted);
		margin: 0;
	}

	.spacer {
		flex: 1;
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	/* ── Sessions list ─────────────────────────────────────────── */
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

	.session-rows {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.no-results {
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
		text-align: center;
		padding: 32px 0;
		margin: 0;
	}

	/* ── First-run ─────────────────────────────────────────────── */
	.first-run {
		max-width: 880px;
		margin: 0 auto;
		padding: 64px 32px 48px;
		display: flex;
		flex-direction: column;
		gap: 36px;
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: center;
		text-align: center;
	}

	.hero-kicker {
		font-size: var(--cinder-text-sm);
		font-weight: 700;
		letter-spacing: 0.24em;
		color: var(--cinder-text-subtle);
	}

	.hero-title {
		margin: 0;
		font-size: 28px;
		font-weight: 650;
		letter-spacing: -0.01em;
		text-wrap: balance;
	}

	.hero-description {
		margin: 0;
		max-width: 520px;
		font-size: var(--cinder-text-sm);
		line-height: 1.6;
		color: var(--cinder-text-subtle);
		text-wrap: pretty;
	}

	.composer-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
	}

	.enter-hint {
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.starter-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}

	.starter-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		text-align: left;
		padding: 16px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		cursor: pointer;
		font: inherit;
		color: var(--cinder-text);
		box-shadow: var(--cinder-shadow-sm);
	}

	.starter-card:hover {
		border-color: var(--cinder-accent);
		background: var(--cinder-surface-hover);
	}

	.starter-kicker {
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cinder-accent-text);
	}

	.starter-title {
		font-size: var(--cinder-text-sm);
		font-weight: 600;
	}

	.starter-body {
		font-size: var(--cinder-text-xs);
		line-height: 1.55;
		color: var(--cinder-text-subtle);
	}

	.concept-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 18px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
	}

	.concept-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.concept-title {
		margin: 0;
		font-size: var(--cinder-text-sm);
		font-weight: 650;
	}

	.concept-link {
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		color: var(--cinder-accent-text);
		text-decoration: none;
	}

	.concept-link:hover {
		text-decoration: underline;
	}

	.concept-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 8px;
	}

	.concept-cell {
		display: grid;
		gap: 4px;
		padding: 10px 11px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
	}

	.concept-app {
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		color: var(--cinder-text);
	}

	.concept-temporal {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-accent-text);
	}

	.concept-footnote {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}
</style>
