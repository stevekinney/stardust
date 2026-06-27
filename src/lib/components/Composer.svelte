<script lang="ts">
	type Props = {
		disabled?: boolean;
		running?: boolean;
		onSubmit: (message: string) => void;
		onSteer?: (message: string) => void;
		onInterrupt?: () => void;
	};

	let { disabled = false, running = false, onSubmit, onSteer, onInterrupt }: Props = $props();

	let message = $state('');
	let steeringMessage = $state('');
	let steeringOpen = $state(false);

	function handleSubmit() {
		const trimmed = message.trim();
		if (!trimmed || disabled) return;
		onSubmit(trimmed);
		message = '';
	}

	function handleSteer() {
		const trimmed = steeringMessage.trim();
		if (!trimmed || !onSteer) return;
		onSteer(trimmed);
		steeringMessage = '';
		steeringOpen = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		}
	}
</script>

<div class="composer" aria-label="Message composer">
	<div class="main-row">
		<textarea
			class="message-input"
			bind:value={message}
			onkeydown={handleKeydown}
			placeholder="Type a message…"
			rows="3"
			{disabled}
			aria-label="Message"></textarea>
		<div class="action-column">
			<button
				type="button"
				class="submit-button"
				onclick={handleSubmit}
				disabled={disabled || !message.trim()}
				aria-label="Send message"
			>
				Send
			</button>
			{#if running && onInterrupt}
				<button type="button" class="interrupt-button" onclick={onInterrupt} aria-label="Interrupt">
					Stop
				</button>
			{/if}
			{#if onSteer && running}
				<button
					type="button"
					class="steer-button"
					onclick={() => (steeringOpen = !steeringOpen)}
					aria-label="Steer"
					aria-expanded={steeringOpen}
				>
					Steer
				</button>
			{/if}
		</div>
	</div>

	{#if steeringOpen}
		<div class="steering-row">
			<textarea
				class="steering-input"
				bind:value={steeringMessage}
				placeholder="Steering message…"
				rows="2"
				aria-label="Steering message"></textarea>
			<button
				type="button"
				class="steer-submit-button"
				onclick={handleSteer}
				disabled={!steeringMessage.trim()}
				aria-label="Send steering message"
			>
				Send Steering
			</button>
		</div>
	{/if}
</div>

<style>
	.composer {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-top: 1px solid #d7dde2;
		background: #ffffff;
	}

	.main-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	.message-input,
	.steering-input {
		flex: 1;
		box-sizing: border-box;
		padding: 10px 12px;
		border: 1px solid #c8d0d8;
		border-radius: 8px;
		font: inherit;
		font-size: 0.95rem;
		color: #17202a;
		background: #ffffff;
		resize: none;
		line-height: 1.5;
	}

	.message-input:focus,
	.steering-input:focus {
		outline: none;
		border-color: #174c77;
		box-shadow: 0 0 0 3px rgb(23 76 119 / 0.15);
	}

	.message-input:disabled {
		background: #f3f4f6;
		color: #8a9bac;
	}

	.action-column {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex-shrink: 0;
	}

	.submit-button {
		padding: 10px 20px;
		border: none;
		border-radius: 8px;
		background: #174c77;
		color: #ffffff;
		font: inherit;
		font-size: 0.9rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
	}

	.submit-button:disabled {
		background: #8ba3bd;
		cursor: default;
	}

	.interrupt-button {
		padding: 8px 16px;
		border: 1px solid #9b2c2c;
		border-radius: 8px;
		background: #ffffff;
		color: #9b2c2c;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
	}

	.interrupt-button:hover {
		background: #fff1f1;
	}

	.steer-button {
		padding: 8px 16px;
		border: 1px solid #92400e;
		border-radius: 8px;
		background: #ffffff;
		color: #92400e;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
	}

	.steer-button:hover {
		background: #fffbeb;
	}

	.steering-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	.steer-submit-button {
		padding: 10px 16px;
		border: 1px solid #92400e;
		border-radius: 8px;
		background: #92400e;
		color: #ffffff;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.steer-submit-button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
