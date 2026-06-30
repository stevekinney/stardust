<script lang="ts">
	import Callout from '@lostgradient/cinder/callout';
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
</script>

<section class="sandbox-inspector" aria-labelledby="sandbox-inspector-heading">
	<h2 id="sandbox-inspector-heading">Sandbox Inspector</h2>

	{#if !sandbox}
		<EmptyState
			title="No sandbox provisioned"
			description="No sandbox provisioned for this session."
			headingLevel={3}
		/>
	{:else}
		<!-- Callout does not support data-caveat natively; data attribute passes through via rest spread -->
		<Callout variant="warning" data-caveat>
			<strong>Note:</strong> This sandbox is a local subprocess — not microVM-isolated. It is safe only
			for a trusted, single-user local POC.
		</Callout>

		<!-- Raw <dl> preserved: DescriptionList only supports plain string definitions;
		     sandbox metadata uses <code> and status-pill <span> elements which require HTML. -->
		<dl class="sandbox-meta">
			<div>
				<dt>Provider</dt>
				<dd>{sandbox.provider}</dd>
			</div>
			<div>
				<dt>Status</dt>
				<dd>
					<span class="status-pill" data-status={sandbox.status}>{sandbox.status}</span>
				</dd>
			</div>
			<div>
				<dt>Name</dt>
				<dd><code>{sandbox.name}</code></dd>
			</div>
			<div>
				<dt>Workspace</dt>
				<dd><code class="workspace-path">{sandbox.workspacePath}</code></dd>
			</div>
			<div>
				<dt>Git initialized</dt>
				<dd>{sandbox.gitInitialized ? 'Yes' : 'No'}</dd>
			</div>
		</dl>

		{#if commands.length > 0}
			<div class="panel-section">
				<h3>Recent Commands</h3>
				<ul class="item-list">
					{#each commands as cmd (cmd.id)}
						{@const args = parseArgs(cmd.args)}
						<li class="command-item">
							<div class="item-row">
								<code class="cmd-text">
									{cmd.command}{args.length > 0 ? ' ' + args.join(' ') : ''}
								</code>
								<span
									class="status-pill"
									class:success={cmd.status === 'complete' && cmd.exitCode === 0}
									class:failure={cmd.status === 'failed' ||
										(cmd.exitCode !== null && cmd.exitCode !== 0)}
									data-status={cmd.status}
								>
									{cmd.status}
								</span>
								{#if cmd.exitCode !== null}
									<span class="exit-code">exit {cmd.exitCode}</span>
								{/if}
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
	{/if}
</section>

<style>
	.sandbox-inspector {
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
		color: var(--cinder-text-subtle);
	}

	.sandbox-meta {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr));
		gap: 0.6rem;
		margin: 0;
	}

	.sandbox-meta dt {
		color: var(--cinder-text-subtle);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.sandbox-meta dd {
		margin: 0.15rem 0 0;
		font-size: 0.9rem;
	}

	code,
	.workspace-path {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.82rem;
		overflow-wrap: anywhere;
	}

	.status-pill {
		display: inline-block;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
		background: var(--cinder-surface-raised);
	}

	.status-pill[data-status='active'] {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-pill[data-status='terminated'] {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.status-pill.success {
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
	}

	.status-pill.failure {
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
	}

	.panel-section {
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: 0.75rem;
	}

	.item-list {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.command-item {
		border: 1px solid var(--cinder-border-muted);
		border-radius: 5px;
		background: var(--cinder-bg);
		overflow: hidden;
	}

	.command-item .item-row {
		border: none;
		border-radius: 0;
	}

	.command-output {
		border-top: 1px solid var(--cinder-surface-raised);
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

	.cmd-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.exit-code {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		color: var(--cinder-text-subtle);
	}

	.sha {
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
