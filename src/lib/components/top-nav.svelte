<script lang="ts">
	import { resolve } from '$app/paths';
	import Badge from '@lostgradient/cinder/badge';
	import NavigationBar from '@lostgradient/cinder/navigation-bar';
	import NavigationItem from '@lostgradient/cinder/navigation-item';
	import HealthPopover, { type HealthSnapshot } from './health-popover.svelte';
	import { inbox } from '$lib/inbox.svelte';

	let { currentPath, health = null }: { currentPath: string; health?: HealthSnapshot | null } =
		$props();

	const tabs = $derived([
		{
			label: 'Sessions',
			href: resolve('/'),
			active: currentPath === '/' || currentPath.startsWith('/sessions')
		},
		{ label: 'Inbox', href: resolve('/inbox'), active: currentPath.startsWith('/inbox') },
		{
			label: 'Schedules',
			href: resolve('/schedules'),
			active: currentPath.startsWith('/schedules')
		}
	]);
</script>

<NavigationBar label="Primary" class="top-nav">
	{#snippet brand()}
		<a href={resolve('/')} class="brand" aria-label="Stardust home">STARDUST</a>
	{/snippet}

	{#snippet items()}
		{#each tabs as tab (tab.href)}
			<NavigationItem href={tab.href} active={tab.active}>
				{tab.label}
				{#if tab.label === 'Inbox' && inbox.total > 0}
					<Badge variant="accent" size="xs" mono>{inbox.total}</Badge>
				{/if}
			</NavigationItem>
		{/each}
	{/snippet}

	{#snippet actions()}
		<HealthPopover {health} />
		<a href={resolve('/settings')} class="icon-button" aria-label="Settings">
			<!-- settings -->
			<svg
				width="17"
				height="17"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path
					d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
				/>
				<circle cx="12" cy="12" r="3" />
			</svg>
		</a>
	{/snippet}
</NavigationBar>

<style>
	.brand {
		font-size: 12.5px;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--cinder-text);
		text-decoration: none;
	}

	.icon-button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: var(--cinder-radius-md);
		color: var(--cinder-text-subtle);
	}

	.icon-button:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}
</style>
