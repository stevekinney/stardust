<script lang="ts">
	import { resolve } from '$app/paths';

	type Props = {
		/** The current session's key, displayed in the title. */
		sessionKey: string;
		/** Called when the user clicks "New Session". */
		onNewSession: () => void;
	};

	let { sessionKey, onNewSession }: Props = $props();
</script>

<header class="page-header">
	<div class="header-left">
		<a href={resolve('/')} class="back-link" aria-label="Back to sessions list">← Sessions</a>
		<h1 class="session-title" title={sessionKey}>{sessionKey}</h1>
	</div>
	<div class="header-right">
		<button
			type="button"
			class="new-session-button"
			aria-label="New session"
			onclick={onNewSession}
		>
			+ New Session
		</button>
		<a href={resolve('/ops')} class="ops-link" aria-label="Open operator console">Ops ↗</a>
	</div>
</header>

<style>
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.back-link {
		color: var(--cinder-text-subtle);
		text-decoration: none;
		font-size: var(--cinder-text-sm);
		font-weight: 700;
		white-space: nowrap;
	}

	.back-link:hover {
		color: var(--cinder-accent-text);
	}

	.session-title {
		margin: 0;
		font-size: var(--cinder-text-base);
		font-family: var(--cinder-font-mono);
		font-weight: 600;
		color: var(--cinder-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}

	.new-session-button {
		padding: 6px 14px;
		border: 1px solid var(--cinder-accent);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-accent);
		color: var(--cinder-accent-contrast);
		font: inherit;
		font-size: var(--cinder-text-xs);
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
	}

	.new-session-button:hover {
		background: var(--cinder-accent-hover);
	}

	.ops-link {
		color: var(--cinder-text-subtle);
		text-decoration: none;
		font-size: var(--cinder-text-xs);
		font-weight: 700;
	}

	.ops-link:hover {
		color: var(--cinder-accent-text);
	}
</style>
