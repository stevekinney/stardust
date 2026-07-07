<script lang="ts">
	import Modal from '@lostgradient/cinder/modal';
	import Kbd from '@lostgradient/cinder/kbd';
	import { KEYBOARD_SHORTCUTS } from '$lib/keyboard-shortcuts';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	/** Global "?" toggles the dialog, unless the user is typing in a field. */
	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== '?') return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isEditableTarget(event.target)) return;
		event.preventDefault();
		open = !open;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal bind:open title="Keyboard shortcuts">
	<ul class="shortcut-list">
		{#each KEYBOARD_SHORTCUTS as shortcut (shortcut.description)}
			<li class="shortcut-row">
				<span class="shortcut-keys">
					{#each shortcut.keys as key, index (key)}
						<Kbd label={key} size="sm" />
						{#if index < shortcut.keys.length - 1}
							<span class="shortcut-plus">+</span>
						{/if}
					{/each}
				</span>
				<span class="shortcut-description">{shortcut.description}</span>
			</li>
		{/each}
	</ul>
</Modal>

<style>
	.shortcut-list {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.shortcut-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.shortcut-keys {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
		min-width: 96px;
	}

	.shortcut-plus {
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-disabled);
	}

	.shortcut-description {
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
