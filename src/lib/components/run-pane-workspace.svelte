<script lang="ts">
	import { onMount } from 'svelte';
	import WorkspacePanel, {
		type WorkspaceArtifact,
		type WorkspaceCommand,
		type WorkspaceDiff,
		type WorkspaceFile,
		type WorkspaceSnapshot
	} from './workspace-panel.svelte';

	type WorkspaceData = {
		files: WorkspaceFile[];
		commands: WorkspaceCommand[];
		snapshots: WorkspaceSnapshot[];
		artifacts: WorkspaceArtifact[];
		diffs: WorkspaceDiff[];
	};

	let { sessionKey }: { sessionKey: string } = $props();

	let workspace = $state.raw<WorkspaceData | null>(null);
	let error = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/workspace`);
			if (!response.ok) throw new Error(await response.text());
			workspace = (await response.json()) as WorkspaceData;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Failed to load workspace';
		}
	}
</script>

{#if error}
	<p class="notice" role="alert">{error}</p>
{:else if workspace === null}
	<p class="notice">Loading workspace…</p>
{:else}
	<WorkspacePanel
		files={workspace.files}
		commands={workspace.commands}
		snapshots={workspace.snapshots}
		artifacts={workspace.artifacts}
		diffs={workspace.diffs}
	/>
{/if}

<style>
	.notice {
		margin: 0;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}
</style>
