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
		border-bottom: 1px solid #d7dde2;
		background: #ffffff;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.back-link {
		color: #5e6f80;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.back-link:hover {
		color: #174c77;
	}

	.session-title {
		margin: 0;
		font-size: 0.95rem;
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: #1d252c;
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
		border: 1px solid #174c77;
		border-radius: 6px;
		background: #174c77;
		color: #ffffff;
		font: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
	}

	.new-session-button:hover {
		background: #1a5a8e;
	}

	.ops-link {
		color: #5e6f80;
		text-decoration: none;
		font-size: 0.8rem;
		font-weight: 700;
	}

	.ops-link:hover {
		color: #174c77;
	}
</style>
