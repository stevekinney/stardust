<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		title: string;
		meta?: string;
		children?: Snippet;
	};

	let { title, meta, children }: Props = $props();
</script>

<div class="page-header" role="banner">
	<h1 class="page-title">{title}</h1>
	{#if meta}
		<span class="page-meta">{meta}</span>
	{/if}
	<span class="spacer"></span>
	{#if children}
		{@render children()}
	{/if}
</div>

<style>
	.page-header {
		flex: none;
		padding: 12px 22px;
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.page-title {
		font: 650 20px system-ui;
		margin: 0;
		color: var(--cinder-text);
	}

	.page-meta {
		font: 500 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.spacer {
		flex: 1;
	}
</style>
