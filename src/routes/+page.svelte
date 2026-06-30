<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import Textarea from '@lostgradient/cinder/textarea';

	let message = $state('');

	async function mintSessionKey(): Promise<string> {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) throw new Error('Failed to create session');
		const body = (await response.json()) as { sessionKey: string };
		return body.sessionKey;
	}

	function handleSubmit() {
		const trimmed = message.trim();
		if (!trimmed) return;
		void mintSessionKey().then((sessionKey) => {
			const url = resolve(
				`/sessions/${encodeURIComponent(sessionKey)}?start=${encodeURIComponent(trimmed)}`
			);
			void goto(url);
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		}
	}

	function handlePromptClick(text: string) {
		message = text;
		handleSubmit();
	}

	const EXAMPLE_PROMPTS = [
		{
			icon: 'rocket',
			text: 'Deploy the latest build to staging'
		},
		{
			icon: 'test-tube',
			text: 'Run the test suite and report failures'
		},
		{
			icon: 'activity',
			text: 'Summarize recent incidents from the last 24h'
		}
	];
</script>

<svelte:head>
	<title>Stardust</title>
</svelte:head>

<div class="welcome">
	<div class="welcome-content">
		<div class="welcome-icon">
			<!-- lucide sparkles -->
			<svg
				width="23"
				height="23"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path
					d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
				/>
				<path d="M20 3v4" />
				<path d="M22 5h-4" />
				<path d="M4 17v2" />
				<path d="M5 18H3" />
			</svg>
		</div>
		<h2 class="welcome-heading">What should the agent work on?</h2>
		<p class="welcome-description">
			Describe a task. Stardust opens a session, streams its work, and pauses for your approval
			before anything risky. It runs on a durable runtime — close this tab and pick the run back up
			exactly where it was.
		</p>

		<div class="task-input">
			<Textarea
				id="home-task"
				bind:value={message}
				onkeydown={handleKeydown}
				placeholder="e.g. Refactor the auth guards in src/lib/server and run the test suite"
				rows={3}
				aria-label="Describe a task"
			/>
		</div>

		<div class="task-actions">
			<span class="spacer"></span>
			<span class="enter-hint"><span class="mono">Enter</span> to start</span>
			<Button
				label="Start session"
				variant="primary"
				size="md"
				onclick={handleSubmit}
				disabled={!message.trim()}
			>
				<span class="btn-content">
					Start session
					<!-- lucide arrow-up -->
					<svg
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="m5 12 7-7 7 7" />
						<path d="M12 19V5" />
					</svg>
				</span>
			</Button>
		</div>

		<div class="prompt-section">
			<div class="prompt-heading">Or start from</div>
			{#each EXAMPLE_PROMPTS as prompt (prompt.text)}
				<button type="button" class="prompt-card" onclick={() => handlePromptClick(prompt.text)}>
					<svg
						class="prompt-icon"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						{#if prompt.icon === 'rocket'}
							<path
								d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"
							/>
							<path
								d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"
							/>
							<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
							<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
						{:else if prompt.icon === 'test-tube'}
							<path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2" />
							<path d="M8.5 2h7" />
							<path d="M14.5 16h-5" />
						{:else if prompt.icon === 'activity'}
							<path
								d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
							/>
						{/if}
					</svg>
					<span class="prompt-text">{prompt.text}</span>
					<span class="spacer"></span>
					<!-- lucide arrow-up-right -->
					<svg
						class="prompt-arrow"
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M7 7h10v10" />
						<path d="M7 17 17 7" />
					</svg>
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
		width: 48px;
		height: 48px;
		border-radius: 12px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border);
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto;
		color: var(--cinder-accent-text);
	}

	.welcome-heading {
		font: 650 24px/1.2 system-ui;
		letter-spacing: -0.01em;
		margin: 18px 0 0;
		color: var(--cinder-text);
	}

	.welcome-description {
		font: 400 14px/1.6 system-ui;
		margin: 10px 0 0;
		color: var(--cinder-text-muted);
	}

	.task-input {
		margin-top: 22px;
		text-align: left;
	}

	.task-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
	}

	.spacer {
		flex: 1;
	}

	.enter-hint {
		font: 500 11px system-ui;
		color: var(--cinder-text-subtle);
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	.btn-content {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.prompt-section {
		margin-top: 26px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.prompt-heading {
		font: 600 10px system-ui;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		text-align: left;
		color: var(--cinder-text-subtle);
	}

	.prompt-card {
		display: flex;
		align-items: center;
		gap: 11px;
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface);
		padding: 12px 14px;
		cursor: pointer;
		font: inherit;
		color: var(--cinder-text);
		text-align: left;
	}

	.prompt-card:hover {
		border-color: var(--cinder-border-strong);
		background: var(--cinder-surface-hover);
	}

	.prompt-icon {
		color: var(--cinder-accent-text);
		flex-shrink: 0;
	}

	.prompt-text {
		font: 500 13px system-ui;
	}

	.prompt-arrow {
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}
</style>
