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

	let {
		session,
		onOpen,
		onRename
	}: {
		session: SessionRow;
		onOpen: (session: SessionRow) => void;
		/** When provided, a rename affordance renders next to the title. */
		onRename?: (session: SessionRow, name: string) => void;
	} = $props();

	const needsYou = $derived(session.status === 'waiting_approval');
	const meta = $derived(
		`${session.sessionKey} · ${formatStatus(session.status)} · ${relativeTime(session.updatedAt)}`
	);
	const wfChipLabel = $derived(`Open ${session.sessionKey} in Temporal Web`);

	let renaming = $state(false);
	let draftName = $state('');
	// Removing the focused <input> from the DOM (Escape) fires a native blur
	// event synchronously, which would otherwise re-trigger commitRename with
	// stale draft text. This flag lets cancelRename opt the next blur out.
	let ignoreNextBlur = false;

	function startRename(event: MouseEvent) {
		event.stopPropagation();
		draftName = displayLabel(session);
		renaming = true;
	}

	function commitRename() {
		if (ignoreNextBlur) {
			ignoreNextBlur = false;
			return;
		}
		const trimmed = draftName.trim();
		renaming = false;
		if (trimmed && trimmed !== displayLabel(session)) {
			onRename?.(session, trimmed);
		}
	}

	function cancelRename() {
		ignoreNextBlur = true;
		renaming = false;
	}

	function handleRenameKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			(event.currentTarget as HTMLInputElement).blur();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancelRename();
		}
	}

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
	}

	/** Row body is a div (not a button) so the rename control can nest a real <button>. */
	function handleOpenKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onOpen(session);
		}
	}
</script>

<div class="row" class:needs-you={needsYou}>
	<div
		class="open"
		role="button"
		tabindex="0"
		onclick={() => onOpen(session)}
		onkeydown={handleOpenKeydown}
	>
		<span class="dot {statusDotClass(session.status)}" aria-hidden="true"></span>
		<span class="body">
			<span class="title-line">
				{#if renaming}
					<input
						class="title-input"
						type="text"
						bind:value={draftName}
						aria-label="Rename session"
						{@attach focusOnMount}
						onclick={(event) => event.stopPropagation()}
						onblur={commitRename}
						onkeydown={handleRenameKeydown}
					/>
				{:else}
					<span class="title">{displayLabel(session)}</span>
					{#if onRename}
						<button
							type="button"
							class="rename-trigger"
							aria-label="Rename session {displayLabel(session)}"
							onclick={startRename}
						>
							<!-- lucide pencil -->
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
							</svg>
						</button>
					{/if}
				{/if}
				<Badge variant={sessionBadgeVariant(session.status)} size="sm">
					{formatStatus(session.status)}
				</Badge>
				{#if needsYou}
					<span class="needs-you-hint">Review approval →</span>
				{/if}
			</span>
			<span class="meta">{meta}</span>
		</span>
	</div>
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

	.title-input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: var(--cinder-text-sm);
		font-weight: 600;
		color: var(--cinder-text);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-strong);
		border-radius: var(--cinder-radius-sm);
		padding: 2px 6px;
	}

	.rename-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		border-radius: var(--cinder-radius-sm);
		background: transparent;
		color: var(--cinder-text-subtle);
		cursor: pointer;
	}

	.rename-trigger:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
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
