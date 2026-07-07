<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import type { InboxMemoryCandidate } from '$lib/types';

	type Decision = 'saved' | 'discarded';

	type Props = {
		candidates: InboxMemoryCandidate[];
		/** Decisions made during this visit, keyed by candidate id. */
		decisions: Record<string, Decision>;
		onSave: (candidate: InboxMemoryCandidate) => void;
		onDiscard: (candidate: InboxMemoryCandidate) => void;
	};

	let { candidates, decisions, onSave, onDiscard }: Props = $props();
</script>

<section class="group" aria-label="Review when you can">
	<span class="group-label">Review when you can</span>

	{#each candidates as candidate (candidate.id)}
		{@const decision = decisions[candidate.id]}
		<div class="candidate">
			<!-- lucide brain -->
			<svg
				class="candidate-icon"
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path
					d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"
				/>
				<path
					d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"
				/>
				<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
			</svg>
			<div class="candidate-body">
				{#if decision}
					<span class="candidate-text decided">{candidate.content}</span>
					<span class="candidate-meta">
						{decision === 'saved' ? 'saved to memory · idempotent write recorded' : 'discarded'}
					</span>
				{:else}
					<span class="candidate-text">{candidate.content}</span>
					<span class="candidate-meta">
						memory candidate{candidate.sessionKey ? ` · from ${candidate.sessionKey}` : ''}
					</span>
				{/if}
			</div>
			{#if !decision}
				<Button size="xs" variant="secondary" label="Save" onclick={() => onSave(candidate)} />
				<Button size="xs" variant="ghost" label="Discard" onclick={() => onDiscard(candidate)} />
			{/if}
		</div>
	{/each}

	{#if candidates.length === 0}
		<p class="empty">No memory candidates waiting for review.</p>
	{/if}
</section>

<style>
	.group {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.group-label {
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.candidate {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface);
	}

	.candidate-icon {
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}

	.candidate-body {
		display: grid;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.candidate-text {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--cinder-text);
	}

	.candidate-text.decided {
		color: var(--cinder-text-subtle);
		text-decoration: line-through;
	}

	.candidate-meta {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.empty {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
