<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Textarea from '@lostgradient/cinder/textarea';

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
		<Textarea
			id="composer-message"
			bind:value={message}
			onkeydown={handleKeydown}
			placeholder="Type a message…"
			rows={3}
			{disabled}
			aria-label="Message"
			class="message-input"
		/>
		<div class="action-column">
			<Button
				label="Send"
				variant="primary"
				onclick={handleSubmit}
				disabled={disabled || !message.trim()}
				aria-label="Send message"
			/>
			{#if running && onInterrupt}
				<Button label="Interrupt" variant="danger" onclick={onInterrupt} aria-label="Interrupt" />
			{/if}
			{#if onSteer && running}
				<Button
					label="Steer"
					variant="secondary"
					onclick={() => (steeringOpen = !steeringOpen)}
					aria-label="Steer"
					aria-expanded={steeringOpen}
				/>
			{/if}
		</div>
	</div>

	{#if steeringOpen}
		<div class="steering-row">
			<Textarea
				id="composer-steering"
				bind:value={steeringMessage}
				placeholder="Steering message…"
				rows={2}
				aria-label="Steering message"
				class="steering-input"
			/>
			<Button
				label="Send Steering"
				variant="primary"
				onclick={handleSteer}
				disabled={!steeringMessage.trim()}
				aria-label="Send steering message"
			/>
		</div>
	{/if}
</div>

<style>
	.composer {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-top: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
	}

	.main-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	:global(.message-input),
	:global(.steering-input) {
		flex: 1;
	}

	.action-column {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex-shrink: 0;
	}

	.steering-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
</style>
