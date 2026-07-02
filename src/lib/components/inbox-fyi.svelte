<script lang="ts" module>
	/** A handled-without-you notice: an auto-recovery or a completed schedule fire. */
	export type FyiItem = {
		id: string;
		kind: 'recovery' | 'schedule-fire';
		text: string;
		meta: string;
		/** Session to open, when the item came from one. */
		sessionKey?: string | null;
		/** External Temporal Web link, when the item points at raw history. */
		href?: string | null;
	};
</script>

<script lang="ts">
	import { resolve } from '$app/paths';

	let { items }: { items: FyiItem[] } = $props();
</script>

<section class="group" aria-label="FYI — handled without you">
	<span class="group-label">FYI — handled without you</span>

	{#each items as item (item.id)}
		<div class="fyi">
			{#if item.kind === 'recovery'}
				<!-- lucide rotate-cw -->
				<svg
					class="fyi-icon recovery"
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
					<polyline points="23 4 23 10 17 10" />
					<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
				</svg>
			{:else}
				<!-- lucide calendar-clock -->
				<svg
					class="fyi-icon"
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
					<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
					<path d="M16 2v4" />
					<path d="M8 2v4" />
					<path d="M3 10h5" />
					<path d="M17.5 17.5 16 16.3V14" />
					<circle cx="16" cy="16" r="6" />
				</svg>
			{/if}
			<div class="fyi-body">
				<span class="fyi-text">{item.text}</span>
				<span class="fyi-meta">{item.meta}</span>
			</div>
			{#if item.sessionKey}
				<a class="fyi-link" href={resolve(`/sessions/${encodeURIComponent(item.sessionKey)}`)}>
					view session
				</a>
			{:else if item.href}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
				<a class="fyi-link" href={item.href} target="_blank" rel="noreferrer">events ↗</a>
			{/if}
		</div>
	{/each}

	{#if items.length === 0}
		<p class="empty">Nothing has needed handling behind your back.</p>
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

	.fyi {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface);
	}

	.fyi-icon {
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.fyi-icon.recovery {
		color: var(--cinder-success);
	}

	.fyi-body {
		display: grid;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.fyi-text {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--cinder-text);
	}

	.fyi-meta {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.fyi-link {
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--cinder-accent-text);
		text-decoration: none;
	}

	.fyi-link:hover {
		text-decoration: underline;
	}

	.empty {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
