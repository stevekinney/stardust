<script lang="ts">
	import { onMount } from 'svelte';
	import ArtifactCard from '$lib/components/artifact-card.svelte';
	import type { ArtifactListItem } from '$lib/types';

	let artifacts = $state.raw<ArtifactListItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		try {
			const response = await fetch('/api/artifacts');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { artifacts: ArtifactListItem[] };
			artifacts = body.artifacts;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to load artifacts';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Artifacts — Stardust</title>
</svelte:head>

<div class="page">
	<div class="page-head">
		<h1 class="page-title">Artifacts</h1>
		<span class="page-sub">
			Reports, diffs, and tool output too large to keep inline — spilled to disk, linked from
			history.
		</span>
	</div>

	{#if loading}
		<p class="state-text" aria-busy="true">Loading…</p>
	{:else if error}
		<p class="state-text" role="alert">{error}</p>
	{:else if artifacts.length === 0}
		<p class="state-text">
			No artifacts yet. When a tool result outgrows the inline limit it is spilled to disk and shows
			up here.
		</p>
	{:else}
		<div class="grid">
			{#each artifacts as artifact (artifact.id)}
				<ArtifactCard {artifact} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: var(--cinder-content-width);
		margin: 0 auto;
		padding: 28px 32px 48px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.page-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.page-title {
		margin: 0;
		font-size: var(--cinder-text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.page-sub {
		font-size: 12.5px;
		color: var(--cinder-text-subtle);
	}

	.state-text {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}
</style>
