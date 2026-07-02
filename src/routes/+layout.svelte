<script lang="ts">
	import '@lostgradient/cinder/styles/all';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import TopNav from '$lib/components/top-nav.svelte';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	onMount(() => {
		document.documentElement.setAttribute('data-theme', 'dark');
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app">
	<TopNav currentPath={$page.url.pathname} />

	<main class="main">
		{@render children()}
	</main>
</div>

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
