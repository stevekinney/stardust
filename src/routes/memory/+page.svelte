<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@lostgradient/cinder/button';

	type MemoryLayer = 'session' | 'durable' | 'action_sensitive';

	type MemoryNote = {
		id: string;
		sessionId: string;
		layer: MemoryLayer;
		content: string;
		tags: string[];
		confirmedAt: string | null;
		createdAt: string;
	};

	type MemoryCandidate = {
		id: string;
		sessionId: string;
		runId: string;
		layer: MemoryLayer;
		content: string;
		reason: string | null;
		createdAt: string;
	};

	let notes = $state<MemoryNote[]>([]);
	let candidates = $state<MemoryCandidate[]>([]);
	let loading = $state(true);

	let sessionNotes = $derived(notes.filter((n) => n.layer === 'session'));
	let durableNotes = $derived(notes.filter((n) => n.layer === 'durable'));
	let actionSensitiveNotes = $derived(notes.filter((n) => n.layer === 'action_sensitive'));

	let headerMeta = $derived.by(() => {
		const parts: string[] = [];
		if (notes.length > 0) parts.push(`${notes.length} remembered`);
		if (candidates.length > 0) parts.push(`${candidates.length} awaiting review`);
		return parts.join(' · ') || 'No memory entries';
	});

	function shortSessionId(id: string): string {
		return id.length > 8 ? `ses_${id.slice(0, 4)}` : id;
	}

	function timeAgo(iso: string): string {
		const ms = Date.now() - new Date(iso).getTime();
		const minutes = Math.floor(ms / 60000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d ago`;
		return `${Math.floor(days / 7)}w ago`;
	}

	async function confirmCandidate(candidateId: string, sessionKey: string) {
		await fetch(`/api/sessions/${sessionKey}/memory/candidates/${candidateId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'confirm' })
		});
		await loadMemory();
	}

	async function dismissCandidate(candidateId: string, sessionKey: string) {
		await fetch(`/api/sessions/${sessionKey}/memory/candidates/${candidateId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'dismiss' })
		});
		await loadMemory();
	}

	async function loadMemory() {
		try {
			const response = await fetch('/api/memory');
			if (response.ok) {
				const body = (await response.json()) as {
					notes: MemoryNote[];
					candidates: MemoryCandidate[];
				};
				notes = body.notes;
				candidates = body.candidates;
			}
		} catch {
			// Non-fatal
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadMemory();
		const interval = setInterval(() => void loadMemory(), 10_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Memory — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<h1 class="page-title">Memory</h1>
		<span class="page-meta">{headerMeta}</span>
	</div>

	{#if loading}
		<div class="page-center"><span class="page-meta">Loading…</span></div>
	{:else if notes.length === 0 && candidates.length === 0}
		<div class="page-center">
			<div class="empty">
				<div class="empty-icon">
					<svg
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"
						/>
						<path
							d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"
						/>
					</svg>
				</div>
				<h2 class="empty-heading">No memories yet</h2>
				<p class="empty-description">
					As the agent works, it proposes things to remember. New memories appear here as candidates
					for you to review — nothing is saved without your approval.
				</p>
			</div>
		</div>
	{:else}
		<div class="split">
			<div class="notes-pane">
				{#if sessionNotes.length > 0}
					<div class="layer-card">
						<div class="layer-header">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								style="color:var(--cinder-info)"
							>
								<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
								<path d="M3 3v5h5" />
								<path d="M12 7v5l4 2" />
							</svg>
							<span class="layer-title">Session memory</span>
							<span class="layer-desc">— lives only for this session, cleared when it ends</span>
							<span class="spacer"></span>
							<span class="badge badge-info">{sessionNotes.length}</span>
						</div>
						<div class="layer-body">
							{#each sessionNotes as note (note.id)}
								<div class="note-row">
									<span class="note-content">{note.content}</span>
									<span class="note-meta">{shortSessionId(note.sessionId)}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if durableNotes.length > 0}
					<div class="layer-card">
						<div class="layer-header">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								style="color:var(--cinder-accent-text)"
							>
								<ellipse cx="12" cy="5" rx="9" ry="3" />
								<path d="M3 5V19A9 3 0 0 0 21 19V5" />
								<path d="M3 12A9 3 0 0 0 21 12" />
							</svg>
							<span class="layer-title">Durable memory</span>
							<span class="layer-desc"
								>— persists across sessions, every entry was approved by you</span
							>
							<span class="spacer"></span>
							<span class="badge badge-accent">{durableNotes.length}</span>
						</div>
						<div class="layer-body">
							{#each durableNotes as note (note.id)}
								<div class="note-row">
									<span class="note-content">{note.content}</span>
									<span class="note-meta"
										>{note.confirmedAt
											? `approved ${timeAgo(note.confirmedAt)}`
											: shortSessionId(note.sessionId)}</span
									>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if actionSensitiveNotes.length > 0}
					<div class="layer-card layer-warning">
						<div class="layer-header">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								style="color:var(--cinder-color-warning-fg)"
							>
								<path
									d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
								/>
							</svg>
							<span class="layer-title">Action-sensitive memory</span>
							<span class="layer-desc"
								>— these change what needs approval, so they're always shown</span
							>
							<span class="spacer"></span>
							<span class="badge badge-warning">{actionSensitiveNotes.length}</span>
						</div>
						<div class="layer-body">
							{#each actionSensitiveNotes as note (note.id)}
								<div class="note-row">
									<span class="note-content">{note.content}</span>
									<span class="note-meta">{timeAgo(note.createdAt)}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<div class="review-pane">
				<div class="review-header">
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						style="color:var(--cinder-accent-text)"
					>
						<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
						<path
							d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
						/>
					</svg>
					<span class="review-title">Awaiting your review</span>
					{#if candidates.length > 0}
						<span class="badge badge-warning" style="margin-left:auto">{candidates.length}</span>
					{/if}
				</div>
				<p class="review-desc">
					The agent proposes; you decide. Nothing here is saved to durable memory until you accept
					it.
				</p>
				{#if candidates.length === 0}
					<p class="page-meta">No pending candidates.</p>
				{:else}
					<div class="candidates">
						{#each candidates as candidate (candidate.id)}
							<div class="candidate-card">
								<div class="candidate-content">{candidate.content}</div>
								<div class="candidate-meta">
									{candidate.reason ? `${candidate.reason} · ` : ''}{shortSessionId(
										candidate.sessionId
									)} · {timeAgo(candidate.createdAt)}
								</div>
								<div class="candidate-actions">
									<Button
										variant="primary"
										size="sm"
										label="Remember"
										onclick={() => confirmCandidate(candidate.id, candidate.sessionId)}
									/>
									<Button
										variant="ghost"
										size="sm"
										label="Dismiss"
										onclick={() => dismissCandidate(candidate.id, candidate.sessionId)}
									/>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.page-header {
		flex: none;
		padding: 18px 22px 14px;
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.page-title {
		font: 650 20px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.page-meta {
		font: 500 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.page-center {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px;
	}

	.empty {
		text-align: center;
		max-width: 380px;
	}

	.empty-icon {
		width: 52px;
		height: 52px;
		border-radius: 14px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border);
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto 16px;
		color: var(--cinder-text-subtle);
	}

	.empty-heading {
		font: 650 18px system-ui;
		margin: 0 0 8px;
		color: var(--cinder-text);
	}

	.empty-description {
		font: 400 13px/1.6 system-ui;
		margin: 0;
		color: var(--cinder-text-muted);
	}

	.split {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.notes-pane {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 20px 22px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.layer-card {
		border: 1px solid var(--cinder-border);
		border-radius: 12px;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.layer-warning {
		border-color: var(--cinder-color-warning-border);
	}

	.layer-header {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 13px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.layer-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.layer-desc {
		font: 400 11.5px system-ui;
		color: var(--cinder-text-subtle);
	}

	.spacer {
		flex: 1;
	}

	.badge {
		display: inline-block;
		font: 600 10px system-ui;
		padding: 2px 7px;
		border-radius: 6px;
	}

	.badge-info {
		background: var(--cinder-color-info-bg, var(--cinder-surface-inset));
		color: var(--cinder-info);
	}

	.badge-accent {
		background: var(--cinder-accent-bg, var(--cinder-surface-inset));
		color: var(--cinder-accent-text);
	}

	.badge-warning {
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	.layer-body {
		padding: 6px 16px 12px;
	}

	.note-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 0;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.note-row:last-child {
		border-bottom: none;
	}

	.note-content {
		font: 400 13px system-ui;
		flex: 1;
		color: var(--cinder-text);
	}

	.note-meta {
		font: 400 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.review-pane {
		width: 372px;
		flex: none;
		border-left: 1px solid var(--cinder-border);
		overflow: auto;
		padding: 18px;
		background: var(--cinder-surface);
	}

	.review-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.review-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.review-desc {
		font: 400 11.5px/1.5 system-ui;
		color: var(--cinder-text-subtle);
		margin: 8px 0 16px;
	}

	.candidates {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.candidate-card {
		border: 1px solid var(--cinder-border);
		border-radius: 11px;
		background: var(--cinder-surface-raised);
		padding: 13px;
	}

	.candidate-content {
		font: 500 13px/1.45 system-ui;
		color: var(--cinder-text);
	}

	.candidate-meta {
		font: 400 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 9px;
	}

	.candidate-actions {
		display: flex;
		gap: 7px;
		margin-top: 12px;
	}
</style>
