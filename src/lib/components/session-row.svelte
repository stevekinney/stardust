<script lang="ts" module>
	import type { BadgeVariant } from '@lostgradient/cinder/badge';

	/** Groups the nine run states into the three tones the sessions list surfaces. */
	export function sessionTone(status: string): 'running' | 'needs-you' | 'done' {
		switch (status) {
			case 'running':
			case 'streaming':
			case 'loading':
			case 'active':
				return 'running';
			case 'waiting_approval':
			case 'disconnected':
				return 'needs-you';
			default:
				return 'done';
		}
	}

	/** Badge variant for a session status: running → info, needs-you → warning, terminal → success/danger/neutral. */
	export function sessionBadgeVariant(status: string): BadgeVariant {
		if (status === 'failed') return 'danger';
		if (status === 'cancelled') return 'neutral';
		const tone = sessionTone(status);
		if (tone === 'running') return 'info';
		if (tone === 'needs-you') return 'warning';
		return 'success';
	}
</script>

<script lang="ts">
	import Badge from '@lostgradient/cinder/badge';
	import type { SessionRow } from '$lib/types';
	import { displayLabel, formatStatus, relativeTime, statusDotClass } from '$lib/session-display';

	let { session, onOpen }: { session: SessionRow; onOpen: (session: SessionRow) => void } =
		$props();

	const needsYou = $derived(session.status === 'waiting_approval');
	const meta = $derived(
		`${session.sessionKey} · ${formatStatus(session.status)} · ${relativeTime(session.updatedAt)}`
	);
	const wfChipLabel = $derived(`Open ${session.sessionKey} in Temporal Web`);
</script>

<div class="row" class:needs-you={needsYou}>
	<button type="button" class="open" onclick={() => onOpen(session)}>
		<span class="dot {statusDotClass(session.status)}" aria-hidden="true"></span>
		<span class="body">
			<span class="title-line">
				<span class="title">{displayLabel(session)}</span>
				<Badge variant={sessionBadgeVariant(session.status)} size="sm">
					{formatStatus(session.status)}
				</Badge>
				{#if needsYou}
					<span class="needs-you-hint">Review approval →</span>
				{/if}
			</span>
			<span class="meta">{meta}</span>
		</span>
	</button>
	{#if session.temporalWebUrl}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
		<a
			class="wf-chip"
			href={session.temporalWebUrl}
			target="_blank"
			rel="noreferrer"
			aria-label={wfChipLabel}
		>
			<span class="wf-chip-key">{session.sessionKey}</span> ↗
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
</div>

<style>
	.row {
		position: relative;
		display: flex;
		align-items: center;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		box-shadow: var(--cinder-shadow-sm);
	}

	.row:hover {
		background: var(--cinder-surface-hover);
		border-color: var(--cinder-border-strong);
	}

	.row.needs-you {
		border-color: var(--cinder-color-warning-border);
	}

	.open {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
		min-width: 0;
		padding: 13px 16px;
		border: none;
		background: transparent;
		cursor: pointer;
		font: inherit;
		color: var(--cinder-text);
		text-align: left;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.body {
		display: grid;
		gap: 4px;
		min-width: 0;
		flex: 1;
	}

	.title-line {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.title {
		font-size: var(--cinder-text-sm);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.needs-you-hint {
		flex: none;
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		color: var(--cinder-color-warning-fg);
	}

	.meta {
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.wf-chip {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		gap: 5px;
		margin: 0 16px 0 12px;
		padding: 4px 9px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
		background: var(--cinder-surface-inset);
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		text-decoration: none;
		white-space: nowrap;
	}

	/*
	 * `.open` has `min-width: 0` so it absorbs a flex shrink deficit, but
	 * `.wf-chip` doesn't — its `white-space: nowrap` content sets a
	 * non-negotiable minimum width, so the row title (the thing worth
	 * reading) was the only thing giving way, down to a couple of letters.
	 * Below phone width, drop the session key text and keep just the arrow so
	 * the chip stays a small, constant-width tap target instead of forcing
	 * the title to disappear.
	 */
	@media (max-width: 640px) {
		.wf-chip-key {
			display: none;
		}

		.wf-chip {
			margin-inline: 8px;
			padding: 4px 7px;
		}
	}

	.wf-chip:hover {
		color: var(--cinder-accent-text);
		border-color: var(--cinder-border);
	}

	/* Status dot colors — shared vocabulary with session-display's statusDotClass. */
	.dot-success {
		background: var(--cinder-success);
	}

	.dot-danger {
		background: var(--cinder-danger);
	}

	.dot-accent {
		background: var(--cinder-accent);
	}

	.dot-warning {
		background: var(--cinder-warning);
	}

	.dot-info {
		background: var(--cinder-info);
	}

	.dot-muted {
		background: var(--cinder-text-disabled);
	}

	.dot-pulse {
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
</style>
