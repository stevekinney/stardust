<script lang="ts">
	import { resolve } from '$app/paths';
	import { relativeTime } from '$lib/session-display';
	import type { ArtifactListItem } from '$lib/types';

	let { artifact }: { artifact: ArtifactListItem } = $props();

	const name = $derived.by(() => {
		const tail = artifact.objectKey.split('/').at(-1) ?? artifact.id;
		return artifact.toolName ? `${artifact.toolName} output` : tail;
	});

	const kind = $derived.by(() => {
		if (artifact.mimeType.includes('markdown')) return 'report';
		if (artifact.mimeType.includes('diff') || artifact.mimeType.includes('patch')) return 'diff';
		if (artifact.toolName) return 'tool output';
		return 'file';
	});

	const sizeLabel = $derived.by(() => {
		const bytes = artifact.sizeBytes;
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	});

	const sessionLabel = $derived(artifact.sessionName ?? artifact.sessionKey ?? 'unknown session');
</script>

<div class="card">
	<div class="card-head">
		<span class="name">{name}</span>
		<span class="kind">{kind}</span>
	</div>
	<p class="description">
		Produced in {sessionLabel}{artifact.toolName
			? ` by ${artifact.toolName} — too large to keep inline, spilled to disk and linked from history.`
			: '.'}
	</p>
	<div class="meta">
		<span>{sizeLabel} · {relativeTime(artifact.createdAt)} · {sessionLabel}</span>
		<span class="spacer"></span>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- tokenized download URL from the artifact store, not an app route -->
		<a class="open" href={artifact.downloadUrl} target="_blank" rel="noreferrer">open ↗</a>
		{#if artifact.sessionKey}
			<a class="open" href={resolve(`/sessions/${encodeURIComponent(artifact.sessionKey)}`)}>
				session
			</a>
		{/if}
	</div>
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		box-shadow: var(--cinder-shadow-sm);
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.name {
		font-family: var(--cinder-font-mono);
		font-size: 12.5px;
		font-weight: 600;
		color: var(--cinder-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.kind {
		flex: none;
		padding: 1px 7px;
		border-radius: 4px;
		font-size: 9.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.description {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-disabled);
		margin-top: auto;
		min-width: 0;
	}

	.meta > span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.spacer {
		flex: 1;
	}

	.open {
		flex: none;
		font-family: var(--cinder-font-sans);
		font-size: 11px;
		font-weight: 600;
		color: var(--cinder-accent-text);
		text-decoration: none;
		white-space: nowrap;
	}

	.open:hover {
		text-decoration: underline;
	}
</style>
