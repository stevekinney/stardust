<script lang="ts">
	export type WorkspaceFile = {
		path: string;
		mimeType: string;
		sizeBytes: number;
		modifiedAt?: string;
	};

	export type WorkspaceCommand = {
		id: string;
		command: string;
		args: string[];
		status: 'complete' | 'failed' | 'pending' | 'running' | 'timeout' | 'killed';
		exitCode: number | null;
		startedAt: string | null;
		completedAt: string | null;
		stdout?: string | null;
		stderr?: string | null;
	};

	export type WorkspaceSnapshot = {
		id: string;
		externalSnapshotId: string;
		reason: string | null;
		createdAt: string;
	};

	export type WorkspaceArtifact = {
		id: string;
		objectKey: string;
		mimeType: string;
		sizeBytes: number;
		createdAt: string;
	};

	export type WorkspaceDiff = {
		fromSnapshotId: string;
		toSnapshotId: string;
		patch: string;
		createdAt: string;
	};

	type Props = {
		files: WorkspaceFile[];
		commands: WorkspaceCommand[];
		snapshots: WorkspaceSnapshot[];
		artifacts: WorkspaceArtifact[];
		diffs?: WorkspaceDiff[];
	};

	let { files, commands, snapshots, artifacts, diffs = [] }: Props = $props();

	const isEmpty = $derived(
		files.length === 0 &&
			commands.length === 0 &&
			snapshots.length === 0 &&
			artifacts.length === 0 &&
			diffs.length === 0
	);

	function shortSha(sha: string): string {
		return sha.slice(0, 7);
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleTimeString();
	}

	function artifactFilename(objectKey: string): string {
		return objectKey.split('/').at(-1) ?? objectKey;
	}
</script>

<section class="workspace-panel" aria-labelledby="workspace-panel-heading">
	<h2 id="workspace-panel-heading">Workspace</h2>

	{#if isEmpty}
		<p class="empty muted">No workspace data recorded for this run.</p>
	{:else}
		{#if files.length > 0}
			<div class="panel-section">
				<h3>Files</h3>
				<ul class="item-list">
					{#each files as file (file.path)}
						<li class="item-row">
							<span class="item-path">{file.path}</span>
							<span class="item-meta">{file.mimeType}</span>
							<span class="item-meta">{formatSize(file.sizeBytes)}</span>
							{#if file.modifiedAt}
								<time class="item-time" datetime={file.modifiedAt}>
									{formatTimestamp(file.modifiedAt)}
								</time>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if commands.length > 0}
			<div class="panel-section">
				<h3>Commands</h3>
				<ul class="item-list">
					{#each commands as cmd (cmd.id)}
						<li class="command-item">
							<div class="item-row">
								<span class="command-label">
									{cmd.command}
									{#if cmd.args.length > 0}
										{cmd.args.join(' ')}
									{/if}
								</span>
								<span
									class="status-pill"
									class:success={cmd.status === 'complete' && cmd.exitCode === 0}
									class:failure={cmd.status === 'failed' ||
										(cmd.exitCode !== null && cmd.exitCode !== 0)}
								>
									{cmd.status}
								</span>
								{#if cmd.exitCode !== null}
									<span class="exit-code">exit {cmd.exitCode}</span>
								{/if}
							</div>
							{#if cmd.stdout || cmd.stderr}
								<details class="command-output" data-command-output>
									<summary class="output-summary">Output</summary>
									{#if cmd.stdout}
										<pre class="output-pre">{cmd.stdout}</pre>
									{/if}
									{#if cmd.stderr}
										<pre class="output-pre output-stderr">{cmd.stderr}</pre>
									{/if}
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if snapshots.length > 0}
			<div class="panel-section">
				<h3>Snapshots</h3>
				<ul class="item-list">
					{#each snapshots as snap (snap.id)}
						<li class="item-row">
							<code class="sha">{shortSha(snap.externalSnapshotId)}</code>
							{#if snap.reason}
								<span class="snap-reason">{snap.reason}</span>
							{/if}
							<time class="item-time" datetime={snap.createdAt}>
								{formatTimestamp(snap.createdAt)}
							</time>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if artifacts.length > 0}
			<div class="panel-section">
				<h3>Artifacts</h3>
				<ul class="item-list">
					{#each artifacts as artifact (artifact.id)}
						<li class="item-row">
							<span class="item-path">{artifactFilename(artifact.objectKey)}</span>
							<span class="item-meta">{artifact.mimeType}</span>
							<span class="item-meta">{formatSize(artifact.sizeBytes)}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if diffs.length > 0}
			<div class="panel-section">
				<h3>Diffs</h3>
				<ul class="item-list">
					{#each diffs as diff (`${diff.fromSnapshotId}..${diff.toSnapshotId}`)}
						<li class="diff-row">
							<div class="diff-header">
								<code class="sha">{shortSha(diff.fromSnapshotId)}</code>
								<span class="diff-arrow" aria-hidden="true">→</span>
								<code class="sha">{shortSha(diff.toSnapshotId)}</code>
								<time class="item-time" datetime={diff.createdAt}>
									{formatTimestamp(diff.createdAt)}
								</time>
							</div>
							<pre class="diff-patch" data-diff-patch>{diff.patch}</pre>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>

<style>
	.workspace-panel {
		display: grid;
		gap: 1rem;
	}

	h2 {
		margin: 0 0 0.25rem;
	}

	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, CanvasText 60%, transparent);
	}

	.panel-section {
		border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
		padding-top: 0.75rem;
	}

	.item-list {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.item-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0.6rem;
		border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
		border-radius: 5px;
		background: Canvas;
		font-size: 0.85rem;
	}

	.item-path,
	.command-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, monospace;
	}

	.item-meta {
		color: color-mix(in srgb, CanvasText 50%, transparent);
		font-size: 0.78rem;
	}

	.item-time {
		color: color-mix(in srgb, CanvasText 45%, transparent);
		font-size: 0.75rem;
	}

	.status-pill {
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		background: color-mix(in srgb, CanvasText 8%, transparent);
		text-transform: capitalize;
	}

	.status-pill.success {
		background: #e6f3ed;
		color: #17603a;
	}

	.status-pill.failure {
		background: #fff1f1;
		color: #7b1d1d;
	}

	.exit-code {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		color: color-mix(in srgb, CanvasText 55%, transparent);
	}

	.sha {
		font-family: ui-monospace, monospace;
		font-size: 0.8rem;
		background: color-mix(in srgb, CanvasText 6%, transparent);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}

	.snap-reason {
		flex: 1;
		font-size: 0.85rem;
		color: color-mix(in srgb, CanvasText 70%, transparent);
	}

	.command-item {
		border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
		border-radius: 5px;
		background: Canvas;
		overflow: hidden;
	}

	.command-item .item-row {
		border: none;
		border-radius: 0;
	}

	.command-output {
		border-top: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
	}

	.output-summary {
		padding: 0.25rem 0.6rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: color-mix(in srgb, CanvasText 55%, transparent);
		cursor: pointer;
		user-select: none;
	}

	.output-pre {
		overflow-x: auto;
		max-height: 10rem;
		margin: 0;
		padding: 0.4rem 0.6rem;
		background: color-mix(in srgb, CanvasText 5%, Canvas);
		font-size: 0.75rem;
		line-height: 1.4;
		white-space: pre;
	}

	.output-stderr {
		background: color-mix(in srgb, #7b1d1d 4%, Canvas);
	}

	.diff-row {
		border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
		border-radius: 5px;
		padding: 0.4rem 0.6rem;
		background: Canvas;
		font-size: 0.85rem;
	}

	.diff-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
	}

	.diff-arrow {
		color: color-mix(in srgb, CanvasText 45%, transparent);
	}

	.diff-patch {
		overflow-x: auto;
		max-height: 10rem;
		margin: 0;
		border-radius: 4px;
		padding: 0.4rem;
		background: color-mix(in srgb, CanvasText 5%, Canvas);
		font-size: 0.75rem;
		line-height: 1.4;
		white-space: pre;
	}

	.empty {
		margin: 0;
		font-size: 0.9rem;
	}

	.muted {
		color: color-mix(in srgb, CanvasText 55%, transparent);
	}
</style>
