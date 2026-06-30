<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Composer from '$lib/components/Composer.svelte';

	async function mintSessionKey(): Promise<string> {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) throw new Error('Failed to create session');
		const body = (await response.json()) as { sessionKey: string };
		return body.sessionKey;
	}

	function handleHomeSubmit(message: string) {
		void mintSessionKey().then((sessionKey) => {
			const url = resolve(
				`/sessions/${encodeURIComponent(sessionKey)}?start=${encodeURIComponent(message)}`
			);
			void goto(url);
		});
	}

	const EXAMPLE_PROMPTS = [
		'Deploy the latest build to staging',
		'Run the test suite and report failures',
		'Summarize recent incidents from the last 24h',
		'Check the health of all active workers'
	];
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

<div class="welcome">
	<div class="welcome-content">
		<div class="welcome-icon">✦</div>
		<h1 class="welcome-heading">What can I help you with?</h1>
		<p class="welcome-subtitle">Start a new session or select one from the sidebar.</p>

		<div class="start-composer">
			<Composer onSubmit={handleHomeSubmit} />
		</div>

		<div class="example-prompts">
			{#each EXAMPLE_PROMPTS as prompt (prompt)}
				<button type="button" class="example-prompt" onclick={() => handleHomeSubmit(prompt)}>
					{prompt}
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.welcome {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 40px;
	}

	.welcome-content {
		max-width: 560px;
		width: 100%;
		text-align: center;
	}

	.welcome-icon {
		font-size: 2.5rem;
		color: var(--cinder-accent);
		margin-bottom: 16px;
	}

	.welcome-heading {
		margin: 0 0 8px;
		font-size: var(--cinder-text-3xl);
		font-weight: 800;
		color: var(--cinder-text);
		line-height: var(--cinder-leading-tight);
	}

	.welcome-subtitle {
		margin: 0 0 28px;
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-base);
	}

	.start-composer {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		overflow: hidden;
		background: var(--cinder-surface);
	}

	.example-prompts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		margin-top: 20px;
	}

	.example-prompt {
		padding: 10px 14px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface);
		color: var(--cinder-text-subtle);
		font: inherit;
		font-size: var(--cinder-text-sm);
		cursor: pointer;
		text-align: left;
	}

	.example-prompt:hover {
		border-color: var(--cinder-border);
		color: var(--cinder-text);
		background: var(--cinder-surface-hover);
	}
</style>
