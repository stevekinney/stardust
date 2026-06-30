<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import EmptyState from '@lostgradient/cinder/empty-state';
	import type { MemoryCandidate, MemoryNote } from '$lib/server/memory/memory-store';

	type Props = {
		notes: MemoryNote[];
		candidates: MemoryCandidate[];
		onApproveCandidate?: (id: string) => void;
		onEditCandidate?: (id: string) => void;
		onDiscardCandidate?: (id: string) => void;
	};

	let { notes, candidates, onApproveCandidate, onEditCandidate, onDiscardCandidate }: Props =
		$props();

	const sessionNotes = $derived(notes.filter((note) => note.layer === 'session'));
	const durableNotes = $derived(notes.filter((note) => note.layer === 'durable'));
	const actionNotes = $derived(notes.filter((note) => note.layer === 'action_sensitive'));

	const isEmpty = $derived(
		sessionNotes.length === 0 &&
			durableNotes.length === 0 &&
			actionNotes.length === 0 &&
			candidates.length === 0
	);

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleString();
	}
</script>

<section class="memory-panel" aria-labelledby="memory-panel-heading">
	<h2 id="memory-panel-heading">Memory</h2>

	{#if isEmpty}
		<EmptyState
			title="No memory notes"
			description="No memory notes or candidates for this session."
			headingLevel={3}
		/>
	{:else}
		{#if sessionNotes.length > 0}
			<div class="layer-section" data-layer="session">
				<h3 class="layer-heading">Session</h3>
				<ul class="note-list">
					{#each sessionNotes as note (note.id)}
						<li class="note-item">
							<p class="note-content">{note.content}</p>
							{#if note.tags.length > 0}
								<div class="tags">
									{#each note.tags as tag (tag)}
										<span class="tag">{tag}</span>
									{/each}
								</div>
							{/if}
							{#if note.runId}
								<span class="note-run-id" data-run-id>run: {note.runId}</span>
							{/if}
							<time class="note-time" datetime={note.createdAt}
								>{formatTimestamp(note.createdAt)}</time
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if durableNotes.length > 0}
			<div class="layer-section" data-layer="durable">
				<h3 class="layer-heading">Durable</h3>
				<ul class="note-list">
					{#each durableNotes as note (note.id)}
						<li class="note-item">
							<p class="note-content">{note.content}</p>
							{#if note.tags.length > 0}
								<div class="tags">
									{#each note.tags as tag (tag)}
										<span class="tag">{tag}</span>
									{/each}
								</div>
							{/if}
							{#if note.runId}
								<span class="note-run-id" data-run-id>run: {note.runId}</span>
							{/if}
							<time class="note-time" datetime={note.createdAt}
								>{formatTimestamp(note.createdAt)}</time
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if actionNotes.length > 0}
			<div class="layer-section" data-layer="action_sensitive">
				<h3 class="layer-heading">Action-Sensitive</h3>
				<ul class="note-list">
					{#each actionNotes as note (note.id)}
						<li class="note-item">
							<p class="note-content">{note.content}</p>
							{#if note.tags.length > 0}
								<div class="tags">
									{#each note.tags as tag (tag)}
										<span class="tag">{tag}</span>
									{/each}
								</div>
							{/if}
							{#if note.runId}
								<span class="note-run-id" data-run-id>run: {note.runId}</span>
							{/if}
							<time class="note-time" datetime={note.createdAt}
								>{formatTimestamp(note.createdAt)}</time
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if candidates.length > 0}
			<div class="layer-section candidates" data-layer="candidates">
				<h3 class="layer-heading">Pending Candidates</h3>
				<ul class="note-list">
					{#each candidates as candidate (candidate.id)}
						<li class="note-item candidate-item">
							<div class="candidate-meta">
								<span class="layer-tag">{candidate.layer.replace(/_/g, ' ')}</span>
								{#if candidate.reason}
									<span class="candidate-reason">{candidate.reason}</span>
								{/if}
							</div>
							<p class="note-content">{candidate.content}</p>
							{#if candidate.tags.length > 0}
								<div class="tags">
									{#each candidate.tags as tag (tag)}
										<span class="tag">{tag}</span>
									{/each}
								</div>
							{/if}
							<div class="candidate-actions">
								<Button
									label="Approve"
									size="sm"
									variant="secondary"
									onclick={() => onApproveCandidate?.(candidate.id)}
								/>
								<Button
									label="Edit"
									size="sm"
									variant="secondary"
									onclick={() => onEditCandidate?.(candidate.id)}
								/>
								<Button
									label="Discard"
									size="sm"
									variant="ghost-danger"
									onclick={() => onDiscardCandidate?.(candidate.id)}
								/>
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>

<style>
	.memory-panel {
		display: grid;
		gap: 1rem;
	}

	h2 {
		margin: 0 0 0.25rem;
	}

	h3,
	.layer-heading {
		margin: 0 0 0.5rem;
		font-size: 0.875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, CanvasText 60%, transparent);
	}

	.layer-section {
		border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
		padding-top: 0.75rem;
	}

	.note-list {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.note-item {
		border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		background: Canvas;
	}

	.note-content {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.note-time {
		display: block;
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.75rem;
	}

	.note-run-id {
		display: block;
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.72rem;
		font-family: ui-monospace, monospace;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-bottom: 0.35rem;
	}

	.tag {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: color-mix(in srgb, CanvasText 8%, transparent);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.candidates .layer-heading {
		color: #7c3aed;
	}

	.candidate-item {
		border-color: #c4b5fd;
		background: #f5f3ff;
	}

	.candidate-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
		margin-bottom: 0.35rem;
	}

	.layer-tag {
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: #ddd6fe;
		color: #5b21b6;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.candidate-reason {
		color: color-mix(in srgb, CanvasText 55%, transparent);
		font-size: 0.8rem;
		font-style: italic;
	}

	.candidate-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
</style>
