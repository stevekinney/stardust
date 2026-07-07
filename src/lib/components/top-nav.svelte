<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Badge from '@lostgradient/cinder/badge';
	import NavigationBar from '@lostgradient/cinder/navigation-bar';
	import NavigationItem from '@lostgradient/cinder/navigation-item';
	import Kbd from '@lostgradient/cinder/kbd';
	import HealthPopover from './health-popover.svelte';
	import { inbox } from '$lib/inbox.svelte';
	import type { HealthSnapshot } from '$lib/types';

	type Props = {
		currentPath: string;
		health?: HealthSnapshot | null;
		onOpenPalette?: () => void;
	};

	let { currentPath, health = null, onOpenPalette }: Props = $props();

	let mobileMenuOpen = $state(false);

	// The dropdown otherwise stays open across a route change (Cinder never
	// closes it for you), which would leave the backdrop blurring the new
	// page underneath it.
	afterNavigate(() => {
		mobileMenuOpen = false;
	});

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
		},
		{
			label: 'Artifacts',
			href: resolve('/artifacts'),
			active: currentPath.startsWith('/artifacts')
		},
		{ label: 'Insights', href: resolve('/insights'), active: currentPath.startsWith('/insights') }
	]);
</script>

<NavigationBar
	label="Primary"
	class="top-nav"
	menuTogglePlacement="before-brand"
	bind:mobileMenuOpen
>
	{#snippet brand()}
		<a href={resolve('/')} class="brand" aria-label="Stardust home">STARDUST</a>
	{/snippet}

	{#snippet items({ variant })}
		{#each tabs as tab (tab.href)}
			<NavigationItem href={tab.href} active={tab.active} {variant}>
				{tab.label}
				{#if tab.label === 'Inbox' && inbox.total > 0}
					<Badge variant="accent" size="xs" mono>{inbox.total}</Badge>
				{/if}
			</NavigationItem>
		{/each}
	{/snippet}

	{#snippet menuToggle({ 'aria-expanded': ariaExpanded, 'aria-controls': ariaControls, onclick })}
		<button
			type="button"
			class="menu-toggle"
			aria-label="Toggle navigation menu"
			aria-expanded={ariaExpanded}
			aria-controls={ariaControls}
			{onclick}
		>
			{#if ariaExpanded === 'true'}
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
					<path d="M18 6 6 18" />
					<path d="m6 6 12 12" />
				</svg>
			{:else}
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
					<line x1="4" x2="20" y1="6" y2="6" />
					<line x1="4" x2="20" y1="12" y2="12" />
					<line x1="4" x2="20" y1="18" y2="18" />
				</svg>
			{/if}
		</button>
	{/snippet}

	{#snippet actions()}
		{#if onOpenPalette}
			<button
				type="button"
				class="palette-trigger"
				aria-label="Search or run a command"
				onclick={onOpenPalette}
			>
				<!-- lucide search -->
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="8" />
					<path d="m21 21-4.3-4.3" />
				</svg>
				<span class="palette-hint">Search or run a command…</span>
				<Kbd label="⌘K" size="sm" />
			</button>
		{/if}
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

{#if mobileMenuOpen}
	<div class="menu-backdrop" role="presentation" onclick={() => (mobileMenuOpen = false)}></div>
{/if}

<style>
	.brand {
		font-size: 12.5px;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--cinder-text);
		text-decoration: none;
	}

	.palette-trigger {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		height: 30px;
		padding: 0 8px 0 10px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-inset);
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
		cursor: pointer;
		min-width: 220px;
	}

	.palette-trigger:hover {
		border-color: var(--cinder-border-strong);
		color: var(--cinder-text);
	}

	.palette-hint {
		flex: 1;
		text-align: left;
		white-space: nowrap;
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

	.menu-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: var(--cinder-radius-md);
		background: transparent;
		color: var(--cinder-text-subtle);
		cursor: pointer;
	}

	.menu-toggle:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	/*
	 * The tab list, search trigger, and health cluster are each sized to their
	 * own content and don't shrink — below this container width their combined
	 * content no longer fits the bar, so the search trigger drops to icon-only
	 * first (least essential — ⌘K still opens it) to free room for the tabs.
	 */
	@container cinder-navigation-bar (max-width: 80rem) {
		.palette-trigger {
			min-width: 0;
			width: 30px;
			padding: 0;
			justify-content: center;
		}

		.palette-hint,
		.palette-trigger :global(.cinder-kbd) {
			display: none;
		}
	}

	.menu-backdrop {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, var(--cinder-bg) 55%, transparent);
		backdrop-filter: blur(3px);
		/* One below Cinder's dropdown so the open menu still renders on top of it. */
		z-index: calc(var(--cinder-z-dropdown, 1100) - 1);
	}
</style>
