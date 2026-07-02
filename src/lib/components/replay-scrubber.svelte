<script lang="ts">
	import Badge from '@lostgradient/cinder/badge';

	type Props = {
		/** Highest durable transcript sequence — the "live" position. */
		maxSequence: number;
		/** Current cursor. Null means live (pinned to maxSequence). */
		cursor: number | null;
		onScrub: (cursor: number | null) => void;
		/** Summary of the event at the cursor, shown while replaying. */
		cursorSummary?: string | null;
	};

	let { maxSequence, cursor, onScrub, cursorSummary = null }: Props = $props();

	const value = $derived(cursor === null ? maxSequence : Math.min(cursor, maxSequence));
	const isLive = $derived(value >= maxSequence);

	function handleInput(event: Event) {
		const next = Number((event.target as HTMLInputElement).value);
		onScrub(next >= maxSequence ? null : next);
	}
</script>

<div class="scrubber">
	<div class="scrubber-head">
		<span class="scrubber-label">Event history</span>
		<span class="scrubber-count">{value} / {maxSequence} events durable</span>
		<span class="spacer"></span>
		{#if isLive}
			<Badge variant="success" size="sm" mono>LIVE</Badge>
		{:else}
			<Badge variant="warning" size="sm" mono>REPLAY</Badge>
			<button type="button" class="jump-live" onclick={() => onScrub(null)}>Jump to live</button>
		{/if}
	</div>
	<input
		type="range"
		min="1"
		max={maxSequence}
		{value}
		oninput={handleInput}
		aria-label="Replay history scrubber"
	/>
	<p class="scrubber-caption">
		{#if isLive}
			Drag left to rebuild the run at any past event — the same replay a recovering worker performs.
		{:else}
			State rebuilt at event {value}{cursorSummary ? ` — ${cursorSummary}` : ''}. Later events are
			dimmed; this view is derived purely from history.
		{/if}
	</p>
</div>

<style>
	.scrubber {
		display: grid;
		gap: 6px;
		padding: 10px 16px 12px;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: linear-gradient(180deg, var(--cinder-surface-inset) 0%, var(--cinder-surface) 100%);
	}

	.scrubber-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.scrubber-label {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--cinder-text-subtle);
	}

	.scrubber-count {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.spacer {
		flex: 1;
	}

	.jump-live {
		border: none;
		background: transparent;
		color: var(--cinder-accent-text);
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		padding: 0;
	}

	.jump-live:hover {
		text-decoration: underline;
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--cinder-accent);
		cursor: ew-resize;
		margin: 0;
	}

	.scrubber-caption {
		margin: 0;
		font-size: 10.5px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}
</style>
