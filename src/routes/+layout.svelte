<script lang="ts">
	import '@lostgradient/cinder/styles/all';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import CommandPaletteHost from '$lib/components/command-palette.svelte';
	import TopNav from '$lib/components/top-nav.svelte';
	import favicon from '$lib/assets/favicon.svg';
	import type { HealthSnapshot } from '$lib/types';

	const HEALTH_POLL_INTERVAL_MS = 30_000;

	let { children } = $props();

	let health = $state.raw<HealthSnapshot | null>(null);
	let paletteOpen = $state(false);

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

<CommandPaletteHost bind:open={paletteOpen} {health} />

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
