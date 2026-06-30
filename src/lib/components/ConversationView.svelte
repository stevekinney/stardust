<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

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
				{renderModel.terminalStatus === 'failed'
					? 'This run failed. See the error above for details.'
					: 'This run was cancelled.'}
			</span>
			{#if onRetry}
				<button class="run-failure-retry" onclick={onRetry} type="button">Retry</button>
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
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #5e6f80;
	}

	.user-message .message-role {
		color: #174c77;
	}

	.assistant-message .message-role {
		color: #17603a;
	}

	.message-text {
		margin: 0;
		line-height: 1.65;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.thinking-indicator {
		color: #5e6f80;
		font-style: italic;
	}

	.lifecycle-marker {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.78rem;
		color: #5e6f80;
		padding: 4px 0;
	}

	.lifecycle-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #9ba8b4;
		flex-shrink: 0;
	}

	.lifecycle-terminal .lifecycle-dot {
		background: #17603a;
	}

	.lifecycle-label {
		font-size: 0.75rem;
		text-transform: capitalize;
	}

	.subagent-lane {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid #d7dde2;
		border-left: 3px solid #8b5cf6;
		border-radius: 4px;
		background: #faf5ff;
		font-size: 0.85rem;
	}

	.subagent-kind {
		font-size: 0.72rem;
		font-weight: 800;
		text-transform: uppercase;
		color: #7c3aed;
	}

	.subagent-label {
		flex: 1;
		color: #3b1f63;
	}

	.subagent-status {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
		color: #5e6f80;
	}

	.tool-card {
		border: 1px solid #d7dde2;
		border-radius: 6px;
		overflow: hidden;
		font-size: 0.85rem;
	}

	.tool-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: #f3f4f6;
		border-bottom: 1px solid #d7dde2;
	}

	.tool-name {
		font-family: ui-monospace, monospace;
		font-size: 0.82rem;
		font-weight: 700;
		color: #1d252c;
	}

	.tool-status {
		font-size: 0.72rem;
		font-weight: 800;
		text-transform: uppercase;
		color: #17603a;
	}

	.tool-status.tool-error {
		color: #9b2c2c;
	}

	.tool-status.tool-running {
		color: #1d4ed8;
	}

	.tool-input,
	.tool-result {
		padding: 0 12px;
	}

	.tool-input summary,
	.tool-result summary {
		padding: 6px 0;
		cursor: pointer;
		font-size: 0.78rem;
		font-weight: 700;
		color: #5e6f80;
		text-transform: uppercase;
	}

	.tool-result.tool-result-error summary {
		color: #9b2c2c;
	}

	pre {
		margin: 0 0 8px;
		padding: 8px;
		background: #f9fafb;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.8rem;
		line-height: 1.5;
	}

	code {
		font-family: ui-monospace, monospace;
	}

	.approval-notice {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid #fbbf24;
		border-radius: 6px;
		background: #fffbeb;
		color: #78350f;
		font-size: 0.875rem;
	}

	.approval-icon {
		flex-shrink: 0;
	}

	.memory-notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 12px;
		border: 1px solid #d1fae5;
		border-radius: 6px;
		background: #ecfdf5;
		color: #065f46;
		font-size: 0.82rem;
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
		border: 1px solid #f5c6c6;
		border-left: 3px solid #9b2c2c;
		border-radius: 6px;
		background: #fff1f1;
		color: #7b1d1d;
		font-size: 0.875rem;
	}

	.run-failure-banner.run-failure-cancelled {
		border-color: #fcd34d;
		border-left-color: #92400e;
		background: #fffbeb;
		color: #78350f;
	}

	.run-failure-icon {
		flex-shrink: 0;
		font-style: normal;
		font-weight: 700;
	}

	.run-failure-message {
		flex: 1;
	}

	.run-failure-retry {
		flex-shrink: 0;
		padding: 4px 12px;
		border: 1px solid currentColor;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: background 0.1s;
	}

	.run-failure-retry:hover {
		background: rgba(0, 0, 0, 0.06);
	}
</style>
