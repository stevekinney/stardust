<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import Button from '@lostgradient/cinder/button';

	/** A normalized stream event as produced by the SSE endpoint. */
	export type StreamEvent = {
		id: number;
		kind: string;
		payload: string;
	};

	/** A user message rendered before the stream (the turn that started the run). */
	export type UserMessage = {
		text: string;
	};

	type Props = {
		userMessage?: UserMessage | null;
		events?: StreamEvent[];
		running?: boolean;
		onRetry?: (() => void) | null;
	};

	let { userMessage = null, events = [], running = false, onRetry = null }: Props = $props();

	type ToolState = {
		id: string;
		name: string;
		input: unknown;
		result?: unknown;
		isError?: boolean;
	};

	type SubagentState = {
		runId: string;
		kind: string;
		label: string;
		status: 'running' | 'complete' | 'failed' | 'cancelled';
	};

	/**
	 * Compute a consolidated render model from the raw event stream.
	 * We fold assistant.delta events into an accumulated string and match
	 * tool.call + tool.result pairs by tool call ID.
	 */
	const renderModel = $derived.by(() => {
		let assistantText = '';
		const tools = new SvelteMap<string, ToolState>();
		const toolOrder: string[] = [];
		const subagents = new SvelteMap<string, SubagentState>();
		const lifecycleEvents: Array<{ status: string }> = [];
		let terminalStatus: 'complete' | 'failed' | 'cancelled' | null = null;
		let failureReason: string | null = null;
		const approvalRequests: Array<{ approvalId: string; toolName: string }> = [];
		const memoryCandidates: Array<{ content: string }> = [];

		for (const event of events) {
			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(event.payload) as Record<string, unknown>;
			} catch {
				continue;
			}

			switch (event.kind) {
				case 'assistant.delta':
					assistantText += (payload.text as string) ?? '';
					break;

				case 'assistant.message':
					// Full assistant message (when not streaming deltas)
					assistantText = (payload.text as string) ?? assistantText;
					break;

				case 'tool.call': {
					const id = payload.id as string;
					tools.set(id, {
						id,
						name: payload.name as string,
						input: payload.input
					});
					toolOrder.push(id);
					break;
				}

				case 'tool.result': {
					const callId = payload.callId as string;
					const existing = tools.get(callId);
					if (existing) {
						tools.set(callId, {
							...existing,
							result: payload.content,
							isError: (payload.isError as boolean) ?? false
						});
					}
					break;
				}

				case 'lifecycle': {
					const lifecycleStatus = payload.status as string;
					lifecycleEvents.push({ status: lifecycleStatus });
					if (
						lifecycleStatus === 'complete' ||
						lifecycleStatus === 'failed' ||
						lifecycleStatus === 'cancelled'
					) {
						terminalStatus = lifecycleStatus as 'complete' | 'failed' | 'cancelled';
					}
					if (lifecycleStatus === 'failed' && typeof payload.reason === 'string') {
						failureReason = payload.reason;
					}
					break;
				}

				case 'subagent.start': {
					const subRunId = payload.subagentRunId as string;
					subagents.set(subRunId, {
						runId: subRunId,
						kind: payload.kind as string,
						label: payload.label as string,
						status: 'running'
					});
					break;
				}

				case 'subagent.complete': {
					const subRunId = payload.subagentRunId as string;
					const existing = subagents.get(subRunId);
					if (existing) {
						subagents.set(subRunId, {
							...existing,
							status: (payload.status as SubagentState['status']) ?? 'complete'
						});
					}
					break;
				}

				case 'approval.request':
					approvalRequests.push({
						approvalId: payload.approvalId as string,
						toolName: (payload.toolName as string) ?? 'unknown'
					});
					break;

				case 'memory.candidate':
					memoryCandidates.push({ content: payload.content as string });
					break;
			}
		}

		return {
			assistantText,
			tools: toolOrder.map((id) => tools.get(id)!).filter(Boolean),
			subagents: Array.from(subagents.values()),
			lifecycleEvents,
			terminalStatus,
			failureReason,
			approvalRequests,
			memoryCandidates
		};
	});

	function formatInput(input: unknown): string {
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	}

	function formatResult(result: unknown): string {
		if (typeof result === 'string') return result;
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}
</script>

<div class="conversation" aria-label="Conversation">
	<!-- User turn that started this run -->
	{#if userMessage}
		<div class="message user-message" aria-label="User message">
			<span class="message-role">You</span>
			<p class="message-text">{userMessage.text}</p>
		</div>
	{/if}

	<!-- Lifecycle: started marker -->
	{#each renderModel.lifecycleEvents as lifecycle (lifecycle.status)}
		{#if lifecycle.status === 'started'}
			<div class="lifecycle-marker" role="status" aria-label="Run started">
				<span class="lifecycle-dot"></span>
				<span class="lifecycle-label">Run started</span>
			</div>
		{/if}
	{/each}

	<!-- Subagent lanes -->
	{#each renderModel.subagents as subagent (subagent.runId)}
		<div
			class="subagent-lane"
			data-status={subagent.status}
			aria-label="Subagent: {subagent.label}"
		>
			<span class="subagent-kind">{subagent.kind}</span>
			<span class="subagent-label">{subagent.label}</span>
			<span class="subagent-status">{subagent.status}</span>
		</div>
	{/each}

	<!-- Tool call/result pairs -->
	{#each renderModel.tools as tool (tool.id)}
		<div class="tool-card" aria-label="Tool: {tool.name}">
			<div class="tool-header">
				<span class="tool-name">{tool.name}</span>
				{#if tool.result !== undefined}
					<span class="tool-status" class:tool-error={tool.isError}>
						{tool.isError ? 'error' : 'done'}
					</span>
				{:else}
					<span class="tool-status tool-running">running</span>
				{/if}
			</div>
			<!-- Raw <details> preserved: Cinder Collapsible doesn't support dynamic
			     aria-label on the trigger, which tests rely on for textContent assertions. -->
			<details class="tool-input">
				<summary>Input</summary>
				<pre><code>{formatInput(tool.input)}</code></pre>
			</details>
			{#if tool.result !== undefined}
				<details class="tool-result" class:tool-result-error={tool.isError}>
					<summary>Result</summary>
					<pre><code>{formatResult(tool.result)}</code></pre>
				</details>
			{/if}
		</div>
	{/each}

	<!-- Approval notices -->
	{#each renderModel.approvalRequests as approval (approval.approvalId)}
		<div class="approval-notice" role="alert" aria-label="Approval required: {approval.toolName}">
			<span class="approval-icon">⏳</span>
			<span>Waiting for approval: <strong>{approval.toolName}</strong></span>
		</div>
	{/each}

	<!-- Memory candidates -->
	{#each renderModel.memoryCandidates as candidate, i (i)}
		<div class="memory-notice" aria-label="Memory candidate">
			<span class="memory-icon">🧠</span>
			<span class="memory-content">{candidate.content}</span>
		</div>
	{/each}

	<!-- Assistant response (accumulated deltas) -->
	{#if renderModel.assistantText}
		<div class="message assistant-message" aria-label="Assistant message">
			<span class="message-role">Assistant</span>
			<p class="message-text">{renderModel.assistantText}</p>
		</div>
	{:else if running}
		<div class="message assistant-message assistant-thinking" aria-label="Assistant thinking">
			<span class="message-role">Assistant</span>
			<span class="thinking-indicator" aria-live="polite">Thinking…</span>
		</div>
	{/if}

	<!-- Lifecycle: completion marker (complete only) -->
	{#each renderModel.lifecycleEvents as lifecycle (lifecycle.status + '-terminal')}
		{#if lifecycle.status === 'complete'}
			<div class="lifecycle-marker lifecycle-terminal" role="status" aria-label="Run complete">
				<span class="lifecycle-dot"></span>
				<span class="lifecycle-label">Run complete</span>
			</div>
		{/if}
	{/each}

	<!-- Failure / cancellation banner -->
	{#if renderModel.terminalStatus === 'failed' || renderModel.terminalStatus === 'cancelled'}
		<div
			class="run-failure-banner"
			class:run-failure-cancelled={renderModel.terminalStatus === 'cancelled'}
			role="alert"
			aria-label="Run {renderModel.terminalStatus}"
		>
			<span class="run-failure-icon">{renderModel.terminalStatus === 'failed' ? '✗' : '⊘'}</span>
			<span class="run-failure-message">
				{#if renderModel.terminalStatus === 'failed'}
					{#if renderModel.failureReason}
						<span class="run-failure-reason">{renderModel.failureReason}</span>
					{:else}
						This run failed.
					{/if}
				{:else}
					This run was cancelled.
				{/if}
			</span>
			{#if onRetry}
				<Button
					label="Retry"
					variant="secondary"
					size="sm"
					onclick={onRetry}
					class="run-failure-retry"
				/>
			{/if}
		</div>
	{/if}
</div>

<style>
	.conversation {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
	}

	.message {
		display: grid;
		gap: 6px;
	}

	.message-role {
		font-size: var(--cinder-text-xs);
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--cinder-text-subtle);
	}

	.user-message .message-role {
		color: var(--cinder-accent-text);
	}

	.assistant-message .message-role {
		color: var(--cinder-color-success-fg);
	}

	.message-text {
		margin: 0;
		line-height: 1.65;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.thinking-indicator {
		color: var(--cinder-text-subtle);
		font-style: italic;
	}

	.lifecycle-marker {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
		padding: 4px 0;
	}

	.lifecycle-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--cinder-text-disabled);
		flex-shrink: 0;
	}

	.lifecycle-terminal .lifecycle-dot {
		background: var(--cinder-success);
	}

	.lifecycle-label {
		font-size: var(--cinder-text-xs);
		text-transform: capitalize;
	}

	.subagent-lane {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--cinder-border-muted);
		border-left: 3px solid var(--cinder-accent);
		border-radius: var(--cinder-radius-sm);
		background: var(--cinder-surface);
		font-size: var(--cinder-text-sm);
	}

	.subagent-kind {
		font-size: var(--cinder-text-2xs);
		font-weight: 800;
		text-transform: uppercase;
		color: var(--cinder-accent-text);
	}

	.subagent-label {
		flex: 1;
		color: var(--cinder-text);
	}

	.subagent-status {
		font-size: var(--cinder-text-2xs);
		font-weight: 700;
		text-transform: capitalize;
		color: var(--cinder-text-subtle);
	}

	.tool-card {
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		overflow: hidden;
		font-size: var(--cinder-text-sm);
	}

	.tool-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: var(--cinder-surface);
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	.tool-name {
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-sm);
		font-weight: 700;
		color: var(--cinder-text);
	}

	.tool-status {
		font-size: var(--cinder-text-2xs);
		font-weight: 800;
		text-transform: uppercase;
		color: var(--cinder-color-success-fg);
	}

	.tool-status.tool-error {
		color: var(--cinder-color-danger-fg);
	}

	.tool-status.tool-running {
		color: var(--cinder-color-info-fg);
	}

	.tool-input,
	.tool-result {
		padding: 0 12px;
	}

	.tool-input summary,
	.tool-result summary {
		padding: 6px 0;
		cursor: pointer;
		font-size: var(--cinder-text-xs);
		font-weight: 700;
		color: var(--cinder-text-subtle);
		text-transform: uppercase;
	}

	.tool-result.tool-result-error summary {
		color: var(--cinder-color-danger-fg);
	}

	pre {
		margin: 0 0 8px;
		padding: 8px;
		background: var(--cinder-surface-inset);
		border-radius: var(--cinder-radius-sm);
		overflow-x: auto;
		font-size: var(--cinder-text-xs);
		line-height: 1.5;
	}

	code {
		font-family: var(--cinder-font-mono);
	}

	.approval-notice {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--cinder-color-warning-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
		font-size: var(--cinder-text-sm);
	}

	.approval-icon {
		flex-shrink: 0;
	}

	.memory-notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 12px;
		border: 1px solid var(--cinder-color-success-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
		font-size: var(--cinder-text-sm);
	}

	.memory-icon {
		flex-shrink: 0;
		margin-top: 1px;
	}

	.memory-content {
		line-height: 1.5;
	}

	.run-failure-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--cinder-color-danger-border);
		border-left: 3px solid var(--cinder-danger);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-danger-bg);
		color: var(--cinder-color-danger-fg);
		font-size: var(--cinder-text-sm);
	}

	.run-failure-banner.run-failure-cancelled {
		border-color: var(--cinder-color-warning-border);
		border-left-color: var(--cinder-warning);
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
	}

	.run-failure-icon {
		flex-shrink: 0;
		font-style: normal;
		font-weight: 700;
	}

	.run-failure-message {
		flex: 1;
	}

	.run-failure-reason {
		display: block;
		word-break: break-word;
	}
</style>
