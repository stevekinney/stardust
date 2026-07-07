<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';

	type Props = {
		inspector: RunInspectorProjection | null;
		inspectorLoading: boolean;
		onInspect: (sessionKey: string, runId: string) => void;
		onOpenTemporalWeb: (url: string) => void;
	};

	let { inspector, inspectorLoading, onInspect, onOpenTemporalWeb }: Props = $props();

	let sessionKey = $state('');
	let runId = $state('');
	let formError = $state<string | null>(null);

	function submit() {
		const trimmedSessionKey = sessionKey.trim();
		const trimmedRunId = runId.trim();
		if (!trimmedSessionKey || !trimmedRunId) {
			formError = 'Session key and run id are required.';
			return;
		}
		formError = null;
		onInspect(trimmedSessionKey, trimmedRunId);
	}
</script>

<section class="panel" aria-labelledby="manual-inspector-heading">
	<div class="section-heading">
		<div>
			<h2 id="manual-inspector-heading">Manual Run Inspector</h2>
			<p class="muted">Enter a session key and run ID to inspect directly.</p>
		</div>
		{#if inspector}
			<Button
				label="Temporal Web ↗"
				variant="secondary"
				size="sm"
				onclick={() => onOpenTemporalWeb(inspector.temporalWebUrl)}
			/>
		{/if}
	</div>

	<form
		class="inspector-form"
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<Input
			id="inspector-session-key"
			label="Session Key"
			bind:value={sessionKey}
			required
			autocomplete="off"
		/>
		<Input id="inspector-run-id" label="Run Id" bind:value={runId} required autocomplete="off" />
		<Button
			label={inspectorLoading ? 'Loading...' : 'Inspect Run'}
			variant="primary"
			type="submit"
			disabled={inspectorLoading}
			class="form-submit"
		/>
	</form>

	{#if formError}
		<p class="error">{formError}</p>
	{/if}
</section>

<style>
	.panel {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		padding: 20px;
		background: var(--cinder-surface);
	}

	.section-heading {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.section-heading h2,
	.section-heading p {
		margin-bottom: 0;
	}

	form {
		display: grid;
		gap: 14px;
	}

	.inspector-form {
		grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
		align-items: end;
	}

	:global(.form-submit) {
		justify-self: start;
	}

	.error {
		border-left: 4px solid var(--cinder-danger);
		margin: 0;
		padding: 12px 14px;
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.muted {
		margin: 0;
		color: var(--cinder-text-subtle);
	}

	@media (max-width: 760px) {
		.section-heading {
			align-items: stretch;
			flex-direction: column;
		}

		form,
		.inspector-form {
			grid-template-columns: 1fr;
		}
	}
</style>
