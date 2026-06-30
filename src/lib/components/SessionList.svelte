<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import SearchField from '@lostgradient/cinder/search-field';

	export type SessionRow = {
		id: string;
		sessionKey: string;
		status: string;
		workflowId: string;
		createdAt: string;
		updatedAt: string;
		/** Human-readable label; falls back to sessionKey when absent. */
		name?: string | null;
		/** ISO timestamp when archived; null/undefined means not archived. */
		archivedAt?: string | null;
	};

	type Props = {
		sessions?: SessionRow[];
		loading?: boolean;
		error?: string | null;
		selectedSessionKey?: string | null;
		onSelect: (session: SessionRow) => void;
		onCreate: () => void;
		onRename?: (session: SessionRow) => void;
		onArchive?: (session: SessionRow) => void;
	};

	let {
		sessions = [],
		loading = false,
		error = null,
		selectedSessionKey = null,
		onSelect,
		onCreate,
		onRename,
		onArchive
	}: Props = $props();

	let search = $state('');

	const active = $derived(sessions.filter((s) => !s.archivedAt));

	const filtered = $derived(
		search.trim()
			? active.filter(
					(s) =>
						(s.name ?? s.sessionKey).toLowerCase().includes(search.trim().toLowerCase()) ||
						s.sessionKey.toLowerCase().includes(search.trim().toLowerCase())
				)
			: active
	);

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	function formatStatus(status: string) {
		return status.replace(/_/g, ' ');
	}

	function displayLabel(session: SessionRow): string {
		return session.name ?? session.sessionKey;
	}
</script>

<div class="session-list-panel" aria-label="Sessions">
	<div class="list-header">
		<h2 class="list-heading">Sessions</h2>
		<Button
			label="+ New"
			variant="primary"
			size="sm"
			onclick={onCreate}
			aria-label="New conversation"
		/>
	</div>

	<SearchField
		value={search}
		oninput={(v) => (search = v)}
		placeholder="Search sessions…"
		aria-label="Search sessions"
	/>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	{#if loading}
		<p class="muted">Loading sessions…</p>
	{:else if filtered.length === 0}
		<p class="muted">
			{sessions.length === 0
				? 'No sessions yet. Start a new conversation.'
				: 'No sessions match your search.'}
		</p>
	{:else}
		<ul class="list" role="list">
			{#each filtered as session (session.id)}
				<li class="session-row">
					<!-- Raw <button> preserved: full-width list-item layout with class:selected and
					     aria-current requires custom styling that Cinder Button can't accommodate. -->
					<button
						type="button"
						class="session-item"
						class:selected={selectedSessionKey === session.sessionKey}
						onclick={() => onSelect(session)}
						aria-label="Select session {session.sessionKey}"
						aria-current={selectedSessionKey === session.sessionKey ? 'true' : undefined}
					>
						<span class="session-label">{displayLabel(session)}</span>
						<span class="session-meta">
							<span class="status-pill" data-status={session.status}>
								{formatStatus(session.status)}
							</span>
							<span class="session-date">{formatDate(session.updatedAt)}</span>
						</span>
					</button>

					<div class="session-actions">
						<Button
							label="Rename"
							variant="ghost"
							size="sm"
							onclick={() => onRename?.(session)}
							aria-label="Rename session {session.sessionKey}"
						/>
						<Button
							label="Archive"
							variant="ghost-danger"
							size="sm"
							onclick={() => onArchive?.(session)}
							aria-label="Archive session {session.sessionKey}"
						/>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.session-list-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow: hidden;
	}

	.list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.list-heading {
		margin: 0;
		font-size: 1rem;
		font-weight: 800;
		color: var(--cinder-text);
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
	}

	.session-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.session-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface);
		color: var(--cinder-text);
		font: inherit;
		font-size: var(--cinder-text-sm);
		cursor: pointer;
		text-align: left;
	}

	.session-item:hover {
		border-color: var(--cinder-border);
		background: var(--cinder-surface-hover);
	}

	.session-item.selected {
		border-color: var(--cinder-accent);
		background: var(--cinder-surface-raised);
	}

	.session-label {
		font-family: ui-monospace, monospace;
		font-size: 0.82rem;
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

	.session-date {
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
	}

	.status-pill {
		display: inline-block;
		padding: 0.12rem 0.5rem;
		border-radius: var(--cinder-radius-full);
		font-size: var(--cinder-text-2xs);
		font-weight: 800;
		text-transform: capitalize;
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
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

	.status-pill[data-status='idle'] {
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
	}

	.session-actions {
		display: flex;
		gap: 6px;
		padding: 0 4px;
	}

	.error {
		padding: 10px 14px;
		background: var(--cinder-color-danger-bg);
		border-left: 3px solid var(--cinder-danger);
		color: var(--cinder-color-danger-fg);
		font-size: var(--cinder-text-sm);
		margin: 0;
	}

	.muted {
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-sm);
		margin: 0;
	}
</style>
