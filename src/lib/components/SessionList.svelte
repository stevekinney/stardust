<script lang="ts">
	export type SessionRow = {
		id: string;
		sessionKey: string;
		status: string;
		workflowId: string;
		createdAt: string;
		updatedAt: string;
	};

	type Props = {
		sessions?: SessionRow[];
		loading?: boolean;
		error?: string | null;
		selectedSessionKey?: string | null;
		onSelect: (session: SessionRow) => void;
		onCreate: () => void;
	};

	let {
		sessions = [],
		loading = false,
		error = null,
		selectedSessionKey = null,
		onSelect,
		onCreate
	}: Props = $props();

	let search = $state('');

	const filtered = $derived(
		search.trim()
			? sessions.filter((s) => s.sessionKey.toLowerCase().includes(search.trim().toLowerCase()))
			: sessions
	);

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	function formatStatus(status: string) {
		return status.replace(/_/g, ' ');
	}
</script>

<div class="session-list-panel" aria-label="Sessions">
	<div class="list-header">
		<h2 class="list-heading">Sessions</h2>
		<button type="button" class="new-button" onclick={onCreate} aria-label="New conversation">
			+ New
		</button>
	</div>

	<input
		class="search-input"
		type="search"
		bind:value={search}
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
				<li>
					<button
						type="button"
						class="session-item"
						class:selected={selectedSessionKey === session.sessionKey}
						onclick={() => onSelect(session)}
						aria-current={selectedSessionKey === session.sessionKey ? 'true' : undefined}
					>
						<span class="session-key">{session.sessionKey}</span>
						<span class="session-meta">
							<span class="status-pill" data-status={session.status}>
								{formatStatus(session.status)}
							</span>
							<span class="session-date">{formatDate(session.updatedAt)}</span>
						</span>
					</button>
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
		color: #1d252c;
	}

	.new-button {
		padding: 6px 14px;
		border: 1px solid #174c77;
		border-radius: 6px;
		background: #174c77;
		color: #ffffff;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
	}

	.new-button:hover {
		background: #1a5a8e;
	}

	.search-input {
		width: 100%;
		box-sizing: border-box;
		padding: 8px 12px;
		border: 1px solid #c8d0d8;
		border-radius: 6px;
		font: inherit;
		font-size: 0.9rem;
		color: #17202a;
		background: #ffffff;
	}

	.search-input:focus {
		outline: none;
		border-color: #174c77;
		box-shadow: 0 0 0 3px rgb(23 76 119 / 0.12);
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

	.session-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #d7dde2;
		border-radius: 6px;
		background: #f9fafb;
		color: inherit;
		font: inherit;
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}

	.session-item:hover {
		border-color: #174c77;
		background: #f0f7ff;
	}

	.session-item.selected {
		border-color: #174c77;
		background: #eff6ff;
	}

	.session-key {
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
		color: #5e6f80;
		font-size: 0.75rem;
	}

	.status-pill {
		display: inline-block;
		padding: 0.12rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 800;
		text-transform: capitalize;
		background: color-mix(in srgb, #1d252c 10%, transparent);
	}

	.status-pill[data-status='active'],
	.status-pill[data-status='complete'] {
		background: #e6f3ed;
		color: #17603a;
	}

	.status-pill[data-status='failed'] {
		background: #fff1f1;
		color: #7b1d1d;
	}

	.status-pill[data-status='running'],
	.status-pill[data-status='waiting_approval'] {
		background: #eff6ff;
		color: #1d4ed8;
	}

	.status-pill[data-status='idle'] {
		background: #f3f4f6;
		color: #374151;
	}

	.error {
		padding: 10px 14px;
		background: #fff1f1;
		border-left: 3px solid #9b2c2c;
		color: #7b1d1d;
		font-size: 0.875rem;
		margin: 0;
	}

	.muted {
		color: #5e6f80;
		font-size: 0.875rem;
		margin: 0;
	}
</style>
