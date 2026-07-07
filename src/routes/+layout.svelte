<script lang="ts">
	import '@lostgradient/cinder/styles';
	import '@lostgradient/cinder/alert/styles';
	import '@lostgradient/cinder/approval-card/styles';
	import '@lostgradient/cinder/action-row/styles';
	import '@lostgradient/cinder/badge/styles';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/chat/styles';
	import '@lostgradient/cinder/command-item/styles';
	import '@lostgradient/cinder/command-palette/styles';
	import '@lostgradient/cinder/drawer/styles';
	import '@lostgradient/cinder/empty-state/styles';
	import '@lostgradient/cinder/event-stream-viewer/styles';
	import '@lostgradient/cinder/faceted-filter-bar/styles';
	import '@lostgradient/cinder/input/styles';
	import '@lostgradient/cinder/kbd/styles';
	import '@lostgradient/cinder/modal/styles';
	import '@lostgradient/cinder/navigation-bar/styles';
	import '@lostgradient/cinder/navigation-item/styles';
	import '@lostgradient/cinder/number-input/styles';
	import '@lostgradient/cinder/payload-inspector/styles';
	import '@lostgradient/cinder/popover/styles';
	import '@lostgradient/cinder/run-step-timeline/styles';
	import '@lostgradient/cinder/segmented-control/styles';
	import '@lostgradient/cinder/select/styles';
	import '@lostgradient/cinder/slider/styles';
	import '@lostgradient/cinder/source-diff-viewer/styles';
	import '@lostgradient/cinder/stat/styles';
	import '@lostgradient/cinder/stat-group/styles';
	import '@lostgradient/cinder/status-dot/styles';
	import '@lostgradient/cinder/tab/styles';
	import '@lostgradient/cinder/tab-list/styles';
	import '@lostgradient/cinder/tab-panel/styles';
	import '@lostgradient/cinder/tabs/styles';
	import '@lostgradient/cinder/textarea/styles';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import CommandPaletteHost from '$lib/components/command-palette.svelte';
	import KeyboardShortcutsDialog from '$lib/components/keyboard-shortcuts-dialog.svelte';
	import TopNav from '$lib/components/top-nav.svelte';
	import favicon from '$lib/assets/favicon.svg';
	import type { HealthSnapshot } from '$lib/types';

	const HEALTH_POLL_INTERVAL_MS = 30_000;

	let { children } = $props();

	let health = $state.raw<HealthSnapshot | null>(null);
	let paletteOpen = $state(false);
	let shortcutsOpen = $state(false);

	onMount(() => {
		document.documentElement.setAttribute('data-theme', 'dark');
		void loadHealth();
		const interval = setInterval(() => void loadHealth(), HEALTH_POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	});

	async function loadHealth() {
		try {
			const response = await fetch('/api/health');
			if (!response.ok) return;
			health = (await response.json()) as HealthSnapshot;
		} catch {
			// Non-fatal — the cluster keeps its last snapshot
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app">
	<TopNav currentPath={$page.url.pathname} {health} onOpenPalette={() => (paletteOpen = true)} />

	<main class="main">
		{@render children()}
	</main>
</div>

<CommandPaletteHost
	bind:open={paletteOpen}
	{health}
	onOpenShortcuts={() => (shortcutsOpen = true)}
/>
<KeyboardShortcutsDialog bind:open={shortcutsOpen} />

<style>
	:global(html) {
		color-scheme: dark;
	}

	:global(body) {
		margin: 0;
		background: var(--cinder-bg);
		color: var(--cinder-text);
		font-family: var(--cinder-font-sans);
		font-size: var(--cinder-text-base);
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		background: var(--cinder-bg);
	}

	.main {
		flex: 1;
		min-height: 0;
		overflow: auto;
		background: var(--cinder-bg);
	}
</style>
