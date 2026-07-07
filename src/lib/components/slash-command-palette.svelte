<script lang="ts">
	import type { SlashCommand, SlashCommandContext } from '$lib/slash-commands';

	type Props = {
		/** Base id used to derive the listbox id and per-option ids for `aria-activedescendant`. */
		id: string;
		commands: SlashCommand[];
		activeIndex: number;
		context: SlashCommandContext;
		onselect: (command: SlashCommand) => void;
	};

	let { id, commands, activeIndex, context, onselect }: Props = $props();

	export function optionId(commandId: string): string {
		return `${id}-option-${commandId}`;
	}
</script>

<div class="slash-palette" role="listbox" id="{id}-listbox" aria-label="Slash commands">
	{#if commands.length === 0}
		<p class="slash-empty">No matching commands</p>
	{:else}
		{#each commands as command, index (command.id)}
			{@const reason = command.unavailable(context)}
			<div
				id={optionId(command.id)}
				role="option"
				tabindex="-1"
				aria-selected={index === activeIndex}
				aria-disabled={reason !== null || undefined}
				class="slash-option"
				class:slash-option-active={index === activeIndex}
				class:slash-option-disabled={reason !== null}
				onpointerdown={(event) => {
					event.preventDefault();
					onselect(command);
				}}
			>
				<span class="slash-name">{command.name}</span>
				<span class="slash-description">{reason ?? command.description}</span>
			</div>
		{/each}
	{/if}
</div>

<style>
	.slash-palette {
		max-height: 260px;
		overflow-y: auto;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-elevated, var(--cinder-surface));
		box-shadow: var(--cinder-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.24));
		padding: 4px;
	}

	.slash-empty {
		margin: 0;
		padding: 10px 12px;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.slash-option {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--cinder-radius-sm);
		cursor: pointer;
	}

	.slash-option-active {
		background: var(--cinder-surface-hover);
	}

	.slash-option-disabled {
		cursor: default;
		opacity: 0.6;
	}

	.slash-name {
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-sm);
		font-weight: 600;
		color: var(--cinder-text);
		flex-shrink: 0;
	}

	.slash-description {
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
	}
</style>
