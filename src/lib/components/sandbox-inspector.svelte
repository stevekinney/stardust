<script lang="ts">
	import Alert from '@lostgradient/cinder/alert';
	import Badge from '@lostgradient/cinder/badge';
	import EmptyState from '@lostgradient/cinder/empty-state';

	export type SandboxInfo = {
		id: string;
		sessionId: string;
		name: string;
		provider: string;
		workspacePath: string;
		status: 'active' | 'suspended' | 'terminated';
		gitInitialized: boolean;
		createdAt: string;
		updatedAt: string;
	};

	export type SandboxCommandRow = {
		id: string;
		command: string;
		args: string | null; // JSON string[]
		status: 'pending' | 'running' | 'complete' | 'failed' | 'timeout' | 'killed';
		exitCode: number | null;
		startedAt: string | null;
		completedAt: string | null;
		createdAt: string;
		stdoutRef?: string | null;
		stderrRef?: string | null;
	};

	export type SandboxSnapshotRow = {
		id: string;
		externalSnapshotId: string;
		reason: string | null;
		createdAt: string;
	};

	type Props = {
		sandbox: SandboxInfo | null;
		commands: SandboxCommandRow[];
		snapshots: SandboxSnapshotRow[];
	};

	let { sandbox, commands, snapshots }: Props = $props();

	function shortSha(sha: string): string {
		return sha.slice(0, 7);
	}

	function parseArgs(raw: string | null): string[] {
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleTimeString();
	}

	function statusLabel(status: SandboxInfo['status']): string {
		if (status === 'active') return 'Running';
		if (status === 'terminated') return 'Stopped';
		return status.charAt(0).toUpperCase() + status.slice(1);
	}

	function exitBadgeVariant(
		exitCode: number | null,
		status: SandboxCommandRow['status']
	): 'success' | 'danger' | 'warning' | 'neutral' {
		if (exitCode === 0) return 'success';
		if (exitCode !== null) return 'danger';
		if (status === 'running' || status === 'pending') return 'warning';
		if (status === 'timeout') return 'warning';
		return 'neutral';
	}

	function formatDuration(startedAt: string | null, completedAt: string | null): string {
		if (!startedAt || !completedAt) return '—';
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}
</script>

<section class="sandbox-inspector" aria-labelledby="sandbox-inspector-heading">
	<h2 id="sandbox-inspector-heading" class="visually-hidden">Sandbox Inspector</h2>

	{#if !sandbox}
		<EmptyState
			title="No sandbox provisioned"
			description="No sandbox provisioned for this session."
			headingLevel={3}
		/>
	{:else}
		<!-- Header -->
		<div class="sandbox-header">
			<div class="header-icon" aria-hidden="true">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
					/>
					<polyline points="3.27 6.96 12 12.01 20.73 6.96" />
					<line x1="12" y1="22.08" x2="12" y2="12" />
				</svg>
			</div>
			<div class="header-info">
				<div class="header-title">Sandbox · {sandbox.sessionId}</div>
				<div class="header-sub">{sandbox.provider} · {sandbox.status} · created recently</div>
			</div>
			<span class="spacer"></span>
			<span class="status-chip" data-status={sandbox.status}>
				<i class="status-dot" aria-hidden="true"></i>
				{statusLabel(sandbox.status)}
			</span>
		</div>

		<!-- 4-column stat grid -->
		<div class="stat-grid">
			<div class="stat-cell">
				<div class="stat-label">Provider</div>
				<div class="stat-value mono">{sandbox.provider}</div>
			</div>
			<div class="stat-cell">
				<div class="stat-label">Working dir</div>
				<div class="stat-value mono">{sandbox.workspacePath}</div>
			</div>
			<div class="stat-cell">
				<div class="stat-label">Commands run</div>
				<div class="stat-value">{commands.length}</div>
			</div>
			<div class="stat-cell">
				<div class="stat-label">Snapshots</div>
				<div class="stat-value">{snapshots.length}</div>
			</div>
		</div>

		<!-- Recent commands table -->
		{#if commands.length > 0}
			<div class="commands-panel">
				<div class="commands-header">
					<span class="col-cmd">Recent commands</span>
					<span class="col-exit">Exit</span>
					<span class="col-dur">Duration</span>
					<span class="col-step">Step</span>
				</div>
				<div class="commands-body">
					{#each commands as cmd (cmd.id)}
						{@const args = parseArgs(cmd.args)}
						{@const cmdText = cmd.command + (args.length > 0 ? ' ' + args.join(' ') : '')}
						<div class="command-row">
							<code class="col-cmd cmd-text">{cmdText}</code>
							<span class="col-exit exit-cell">
								{#if cmd.exitCode !== null}
									<Badge variant={exitBadgeVariant(cmd.exitCode, cmd.status)} size="sm" mono
										>{cmd.exitCode}</Badge
									>
								{:else}
									<Badge variant={exitBadgeVariant(cmd.exitCode, cmd.status)} size="sm"
										>{cmd.status}</Badge
									>
								{/if}
								<span class="visually-hidden">{cmd.status}</span>
							</span>
							<span class="col-dur duration">{formatDuration(cmd.startedAt, cmd.completedAt)}</span>
							<span class="col-step subtle">—</span>
						</div>
						{#if cmd.stdoutRef || cmd.stderrRef}
							<details class="command-output" data-command-output>
								<summary class="output-summary">Output</summary>
								{#if cmd.stdoutRef}
									<pre class="output-pre">{cmd.stdoutRef}</pre>
								{/if}
								{#if cmd.stderrRef}
									<pre class="output-pre output-stderr">{cmd.stderrRef}</pre>
								{/if}
							</details>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<!-- Snapshots -->
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

		<!-- Isolation warning -->
		<Alert variant="warning" data-caveat>
			<strong>Local subprocess is not isolation</strong> — The
			<code>local-subprocess</code> provider runs commands as your user with no network or filesystem
			sandboxing. It is a local subprocess — not a microVM — so treat the approval gate as the real safety
			boundary. Swappable for an isolated provider before exposing the app.
		</Alert>
	{/if}
</section>

<style>
	.sandbox-inspector {
		display: grid;
		gap: 16px;
		background: var(--cinder-bg);
		padding: 20px 22px;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* ── Header ── */
	.sandbox-header {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.header-icon {
		color: var(--cinder-accent-text);
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	.header-info {
		min-width: 0;
	}

	.header-title {
		font:
			600 13.5px system-ui,
			sans-serif;
	}

	.header-sub {
		font-size: 11px;
		margin-top: 2px;
		color: var(--cinder-text-subtle);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.spacer {
		flex: 1;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border: 1px solid var(--cinder-color-neutral-border, var(--cinder-border));
		border-radius: 20px;
		padding: 4px 11px;
		font:
			600 11px system-ui,
			sans-serif;
		flex-shrink: 0;
	}

	.status-chip[data-status='active'] {
		border-color: var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-chip[data-status='suspended'] {
		border-color: var(--cinder-color-warning-border, var(--cinder-border));
		background: var(--cinder-color-warning-bg, var(--cinder-surface-raised));
		color: var(--cinder-color-warning-fg, var(--cinder-text));
	}

	.status-chip[data-status='terminated'] {
		border-color: var(--cinder-color-danger-border);
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.status-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}

	/* ── Stat grid ── */
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 12px;
	}

	.stat-cell {
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface);
		padding: 12px;
	}

	.stat-label {
		font:
			600 9.5px system-ui,
			sans-serif;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.stat-value {
		font:
			600 14px system-ui,
			sans-serif;
		margin-top: 5px;
	}

	.stat-value.mono {
		font:
			600 11.5px ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			monospace;
		word-break: break-all;
	}

	/* ── Commands table ── */
	.commands-panel {
		border: 1px solid var(--cinder-border);
		border-radius: 11px;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.commands-header {
		display: flex;
		padding: 11px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
		font:
			600 11px system-ui,
			sans-serif;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.command-row {
		display: flex;
		align-items: center;
		padding: 10px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
		font:
			500 12px ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			monospace;
	}

	.command-row:last-of-type {
		border-bottom: none;
	}

	.col-cmd {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.col-exit {
		width: 90px;
		flex-shrink: 0;
	}

	.col-dur {
		width: 80px;
		text-align: right;
		flex-shrink: 0;
	}

	.col-step {
		width: 130px;
		text-align: right;
		flex-shrink: 0;
	}

	.cmd-text {
		font-family: inherit;
		font-size: inherit;
	}

	.exit-cell {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.duration {
		color: var(--cinder-text-muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 12px;
	}

	.subtle {
		color: var(--cinder-text-subtle);
	}

	/* ── Command output ── */
	.command-output {
		border-top: 1px solid var(--cinder-border-muted);
	}

	.output-summary {
		padding: 0.25rem 0.6rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--cinder-text-subtle);
		cursor: pointer;
		user-select: none;
	}

	.output-pre {
		overflow-x: auto;
		max-height: 10rem;
		margin: 0;
		padding: 0.4rem 0.6rem;
		background: var(--cinder-surface-inset);
		font-size: 0.75rem;
		line-height: 1.4;
		white-space: pre;
	}

	.output-stderr {
		background: var(--cinder-color-danger-bg);
	}

	/* ── Snapshots ── */
	.panel-section {
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
	}

	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--cinder-text-subtle);
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
		border: 1px solid var(--cinder-border-muted);
		border-radius: 5px;
		background: var(--cinder-bg);
		font-size: 0.85rem;
	}

	.sha {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.82rem;
		background: var(--cinder-surface-inset);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}

	.snap-reason {
		flex: 1;
		font-size: 0.85rem;
		color: var(--cinder-text-subtle);
	}

	.item-time {
		color: var(--cinder-text-disabled);
		font-size: 0.75rem;
	}
</style>
