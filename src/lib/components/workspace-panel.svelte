<script lang="ts">
	import EmptyState from '@lostgradient/cinder/empty-state';
	import Badge from '@lostgradient/cinder/badge';
	import Button from '@lostgradient/cinder/button';
	import SourceDiffViewer from '@lostgradient/cinder/source-diff-viewer';

	export type WorkspaceFile = {
		path: string;
		mimeType: string;
		sizeBytes: number;
		modifiedAt?: string;
		status?: 'new' | 'modified';
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
		downloadUrl: string;
	};

	export type WorkspaceDiff = {
		fromSnapshotId: string;
		toSnapshotId: string;
		patch: string;
		createdAt: string;
		fileName?: string;
		stepRef?: { number: number; name: string };
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

	let selectedDiffIndex = $state(0);
	const activeDiff = $derived(diffs[selectedDiffIndex] ?? diffs[0] ?? null);

	const lineStats = $derived.by(() => {
		let additions = 0;
		let deletions = 0;
		for (const diff of diffs) {
			for (const line of diff.patch.split('\n')) {
				if (line.startsWith('+') && !line.startsWith('+++')) additions++;
				if (line.startsWith('-') && !line.startsWith('---')) deletions++;
			}
		}
		return { additions, deletions };
	});

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

	function pathDir(path: string): string {
		const parts = path.split('/');
		return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
	}

	function pathBasename(path: string): string {
		return path.split('/').at(-1) ?? path;
	}

	function isDiffNewFile(patch: string): boolean {
		return patch.includes('new file mode') || patch.includes('--- /dev/null');
	}

	function isJsonArtifact(mimeType: string): boolean {
		return mimeType === 'application/json' || mimeType.endsWith('+json');
	}

	function extractDiffFilename(diff: WorkspaceDiff): string {
		if (diff.fileName) return diff.fileName;
		const match = diff.patch.match(/\+\+\+ b\/(.+)/);
		return match?.[1] ?? 'diff';
	}
</script>

<section class="workspace-panel" aria-labelledby="workspace-panel-heading">
	<header class="workspace-header">
		<svg
			class="icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M18 19a5 5 0 0 1-5-5v8" />
			<path
				d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"
			/>
			<circle cx="13" cy="12" r="2" />
			<circle cx="20" cy="19" r="2" />
		</svg>
		<h2 id="workspace-panel-heading">Workspace</h2>
		{#if lineStats.additions > 0 || lineStats.deletions > 0}
			<span class="line-stats">
				<span class="stat-add">+{lineStats.additions}</span>
				<span class="stat-del">−{lineStats.deletions}</span>
			</span>
		{/if}
	</header>

	{#if isEmpty}
		<EmptyState
			title="No workspace data"
			description="No workspace data recorded for this run."
			headingLevel={3}
		/>
	{:else}
		<div class="workspace-body">
			<!-- LEFT SIDEBAR: 236px -->
			<aside class="sidebar-left">
				{#if files.length > 0}
					<div class="sidebar-label">Changed files</div>
					{#each files as file (file.path)}
						<div class="file-row">
							<span class="file-status" class:status-new={file.status === 'new'}>
								{file.status === 'new' ? '+' : '~'}
							</span>
							<span class="file-name">
								<span class="file-dir">{pathDir(file.path)}</span>{pathBasename(file.path)}
							</span>
							<span class="file-size">{formatSize(file.sizeBytes)}</span>
							{#if file.status === 'new'}
								<Badge variant="success" size="sm">new</Badge>
							{/if}
						</div>
					{/each}
				{:else if diffs.length > 0}
					<div class="sidebar-label">Diffs</div>
					{#each diffs as diff, i (`${diff.fromSnapshotId}..${diff.toSnapshotId}`)}
						<button
							type="button"
							class="diff-entry"
							class:diff-entry-active={i === selectedDiffIndex}
							onclick={() => {
								selectedDiffIndex = i;
							}}
						>
							<code class="sha">{shortSha(diff.fromSnapshotId)}</code>
							<span class="diff-arrow" aria-hidden="true">→</span>
							<code class="sha">{shortSha(diff.toSnapshotId)}</code>
						</button>
					{/each}
				{/if}
			</aside>

			<!-- CENTER: flex-1 diff pane -->
			<div class="workspace-center">
				{#if activeDiff}
					<div class="diff-file-header">
						<span class="mono diff-filename">{extractDiffFilename(activeDiff)}</span>
						<Badge variant={isDiffNewFile(activeDiff.patch) ? 'success' : 'neutral'} size="sm">
							{isDiffNewFile(activeDiff.patch) ? 'new file' : 'modified'}
						</Badge>
						<span class="diff-sha-pair">
							<code class="sha">{shortSha(activeDiff.fromSnapshotId)}</code>
							<span aria-hidden="true">→</span>
							<code class="sha">{shortSha(activeDiff.toSnapshotId)}</code>
						</span>
						{#if activeDiff.stepRef}
							<a href="#{String(activeDiff.stepRef.number).padStart(2, '0')}a" class="step-link">
								<svg
									class="icon-xs"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M20 20v-7a4 4 0 0 0-4-4H4" />
									<path d="M9 14 4 9l5-5" />
								</svg>
								produced by step {activeDiff.stepRef.number}
							</a>
						{/if}
					</div>
					<SourceDiffViewer
						patch={activeDiff.patch}
						ariaLabel="Workspace diff"
						class="workspace-diff-viewer"
					/>
				{:else}
					<div class="diff-placeholder">
						<span class="subtle-text">No diff to display</span>
					</div>
				{/if}
			</div>

			<!-- RIGHT SIDEBAR: 316px -->
			<aside class="sidebar-right">
				{#if commands.length > 0}
					<div class="right-section">
						<div class="right-section-label">
							<svg
								class="icon-xs"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M12 19h8" />
								<path d="m4 17 6-6-6-6" />
							</svg>
							Commands
						</div>
						{#each commands as cmd (cmd.id)}
							<div class="terminal-box">
								<div class="terminal-cmd">
									<span class="terminal-prompt">$</span>{cmd.command}{cmd.args.length > 0
										? ' ' + cmd.args.join(' ')
										: ''}
								</div>
								{#if cmd.stdout || cmd.stderr}
									<details class="terminal-output" data-command-output>
										<summary class="terminal-summary">Output</summary>
										{#if cmd.stdout}
											<pre class="terminal-pre">{cmd.stdout}</pre>
										{/if}
										{#if cmd.stderr}
											<pre class="terminal-pre terminal-pre-err">{cmd.stderr}</pre>
										{/if}
									</details>
								{/if}
								<div class="terminal-footer">
									<span class="terminal-status">{cmd.status}</span>
									{#if cmd.exitCode !== null}
										<span class="terminal-exit">exit {cmd.exitCode}</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}

				{#if snapshots.length > 0}
					<div class="right-section">
						<div class="right-section-label">
							<svg
								class="icon-xs"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path
									d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"
								/>
								<circle cx="12" cy="13" r="3" />
							</svg>
							Snapshots
						</div>
						{#each snapshots as snap (snap.id)}
							<div class="snapshot-row">
								<code class="sha">{shortSha(snap.externalSnapshotId)}</code>
								{#if snap.reason}
									<span class="snap-reason">{snap.reason}</span>
								{/if}
								<time class="item-time" datetime={snap.createdAt}>
									{formatTimestamp(snap.createdAt)}
								</time>
								<Button variant="ghost" size="xs">Restore</Button>
							</div>
						{/each}
					</div>
				{/if}

				{#if artifacts.length > 0}
					<div class="right-section">
						<div class="right-section-label">
							<svg
								class="icon-xs"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path
									d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"
								/>
								<path d="M12 22V12" />
								<polyline points="3.29 7 12 12 20.71 7" />
								<path d="m7.5 4.27 9 5.15" />
							</svg>
							Artifacts
						</div>
						{#each artifacts as artifact (artifact.id)}
							<div class="artifact-row">
								{#if isJsonArtifact(artifact.mimeType)}
									<svg
										class="icon-xs artifact-icon"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path
											d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
										/>
										<path d="M14 2v5a1 1 0 0 0 1 1h5" />
										<path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
										<path
											d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"
										/>
									</svg>
								{:else}
									<svg
										class="icon-xs artifact-icon"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path
											d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
										/>
										<path d="M14 2v5a1 1 0 0 0 1 1h5" />
									</svg>
								{/if}
								<span class="mono artifact-name">{artifactFilename(artifact.objectKey)}</span>
								<span class="subtle-text artifact-mime">{artifact.mimeType}</span>
								<span class="subtle-text artifact-size">{formatSize(artifact.sizeBytes)}</span>
								<!-- eslint-disable svelte/no-navigation-without-resolve -- tokenized download URL from the artifact store, not an app route -->
								<a
									href={artifact.downloadUrl}
									download={artifactFilename(artifact.objectKey)}
									class="download-link"
									aria-label="Download {artifactFilename(artifact.objectKey)}"
								>
									<svg
										class="icon-xs"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M12 15V3" />
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
										<path d="m7 10 5 5 5-5" />
									</svg>
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
						{/each}
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</section>

<style>
	.workspace-panel {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	/* ── Header ── */

	.workspace-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.workspace-header h2 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		flex: 1;
	}

	.line-stats {
		display: flex;
		gap: 6px;
		font:
			500 11px ui-monospace,
			monospace;
	}

	.stat-add {
		color: var(--cinder-color-success-fg);
	}

	.stat-del {
		color: var(--cinder-color-danger-fg);
	}

	/* ── 3-column body ── */

	.workspace-body {
		display: grid;
		grid-template-columns: 236px 1fr 316px;
		min-height: 400px;
		overflow: hidden;
	}

	/* ── Left sidebar ── */

	.sidebar-left {
		border-right: 1px solid var(--cinder-border-muted);
		overflow-y: auto;
		padding: 10px 8px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sidebar-label {
		font:
			700 10px/1 ui-sans-serif,
			sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cinder-text-subtle);
		padding: 4px 4px 6px;
	}

	.file-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 4px;
		border-radius: 4px;
		font:
			500 12px ui-monospace,
			monospace;
		cursor: default;
	}

	.file-row:hover {
		background: var(--cinder-surface-raised);
	}

	.file-status {
		flex-shrink: 0;
		width: 12px;
		text-align: center;
		color: var(--cinder-warning);
		font-weight: 700;
	}

	.file-status.status-new {
		color: var(--cinder-success);
	}

	.file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-dir {
		color: var(--cinder-text-subtle);
	}

	.file-size {
		flex-shrink: 0;
		font-size: 10px;
		color: var(--cinder-text-disabled);
	}

	.diff-entry {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		border: none;
		border-radius: 4px;
		background: none;
		cursor: pointer;
		font:
			500 11px ui-monospace,
			monospace;
		color: var(--cinder-text);
		width: 100%;
		text-align: left;
	}

	.diff-entry:hover {
		background: var(--cinder-surface-raised);
	}

	.diff-entry-active {
		background: var(--cinder-surface-inset);
	}

	.diff-arrow {
		color: var(--cinder-text-disabled);
	}

	/* ── Center diff pane ── */

	.workspace-center {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-right: 1px solid var(--cinder-border-muted);
	}

	.diff-file-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex-shrink: 0;
		flex-wrap: wrap;
	}

	.diff-filename {
		font:
			500 12px ui-monospace,
			monospace;
	}

	.diff-sha-pair {
		display: flex;
		align-items: center;
		gap: 4px;
		font:
			500 11px ui-monospace,
			monospace;
		color: var(--cinder-text-subtle);
		margin-left: auto;
	}

	.step-link {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--cinder-accent-text);
		text-decoration: none;
	}

	.step-link:hover {
		text-decoration: underline;
	}

	:global(.workspace-diff-viewer) {
		flex: 1;
		min-height: 0;
	}

	.diff-placeholder {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* ── Right sidebar ── */

	.sidebar-right {
		overflow-y: auto;
		padding: 10px 8px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.right-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.right-section-label {
		display: flex;
		align-items: center;
		gap: 5px;
		font:
			700 10px/1 ui-sans-serif,
			sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cinder-text-subtle);
		padding-bottom: 2px;
	}

	/* Terminal box */

	.terminal-box {
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: 6px;
		overflow: hidden;
		font:
			500 12px/1.6 ui-monospace,
			monospace;
	}

	.terminal-cmd {
		padding: 8px 10px 2px;
		color: var(--cinder-accent-text);
	}

	.terminal-prompt {
		margin-right: 5px;
		opacity: 0.5;
	}

	.terminal-output {
		border-top: 1px solid var(--cinder-border-muted);
	}

	.terminal-summary {
		padding: 3px 10px;
		font-size: 10px;
		color: var(--cinder-text-subtle);
		cursor: pointer;
		user-select: none;
		list-style: none;
	}

	.terminal-pre {
		margin: 0;
		padding: 4px 10px;
		font-size: 11px;
		white-space: pre;
		overflow-x: auto;
	}

	.terminal-pre-err {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.terminal-footer {
		padding: 2px 10px 8px;
		display: flex;
		gap: 8px;
		align-items: center;
		color: var(--cinder-text-subtle);
		font-size: 11px;
	}

	/* Snapshot rows */

	.snapshot-row {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
		padding: 8px 10px;
		font-size: 12px;
	}

	.snap-reason {
		flex: 1;
		font-size: 11px;
		color: var(--cinder-text-subtle);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-time {
		color: var(--cinder-text-disabled);
		font-size: 10px;
		white-space: nowrap;
	}

	/* Artifact rows */

	.artifact-row {
		display: flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
		padding: 8px 10px;
		font-size: 12px;
	}

	.artifact-icon {
		flex-shrink: 0;
		color: var(--cinder-accent-text);
	}

	.artifact-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font:
			500 12px ui-monospace,
			monospace;
	}

	.artifact-mime,
	.artifact-size {
		color: var(--cinder-text-subtle);
		font-size: 10px;
		white-space: nowrap;
	}

	.download-link {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		color: var(--cinder-text-subtle);
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.download-link:hover {
		color: var(--cinder-text);
	}

	/* Shared utilities */

	.sha {
		font:
			500 11px ui-monospace,
			monospace;
		background: var(--cinder-surface-inset);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.mono {
		font-family: ui-monospace, monospace;
	}

	.subtle-text {
		color: var(--cinder-text-subtle);
	}

	.icon {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		color: var(--cinder-text-subtle);
	}

	.icon-xs {
		width: 13px;
		height: 13px;
		flex-shrink: 0;
	}
</style>
