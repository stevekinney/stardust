<script lang="ts">
	import Chat from '@lostgradient/cinder/chat';
	import type { ChatSubmitEvent, Message } from '@lostgradient/cinder/chat';
	import {
		buildConversation,
		type StreamEvent,
		type UserMessage
	} from '$lib/stream-to-conversation';

	type Props = {
		sessionId: string;
		userMessage?: UserMessage | null;
		events?: StreamEvent[];
		running?: boolean;
		onSubmit: (message: string) => void;
		onRetry?: (() => void) | null;
		onSteer?: (message: string) => void;
		onInterrupt?: () => void;
	};

	let {
		sessionId,
		userMessage = null,
		events = [],
		running = false,
		onSubmit,
		onRetry = null,
		onSteer,
		onInterrupt
	}: Props = $props();

	const conversation = $derived(buildConversation(sessionId, userMessage, events));

	function handleSubmit(event: ChatSubmitEvent) {
		const content = event.message.content;
		const text = typeof content === 'string' ? content : '';
		if (text.trim()) {
			if (running && onSteer) {
				onSteer(text.trim());
			} else {
				onSubmit(text.trim());
			}
		}
	}

	function handleRetry() {
		onRetry?.();
	}

	function handleStopGenerating() {
		onInterrupt?.();
	}

	/**
	 * Custom row rendering for Stardust-specific message types (subagents,
	 * lifecycle markers, memory candidates). Cinder's default row handles
	 * user, assistant, tool-call, and tool-result natively.
	 */
	function isStardustSystemMessage(message: Message): boolean {
		return 'stardust:type' in message.metadata;
	}

	function getStardustType(message: Message): string {
		return (message.metadata['stardust:type'] as string) ?? '';
	}
</script>

{#snippet stardustRow(message: Message, renderDefault: import('svelte').Snippet)}
	{#if isStardustSystemMessage(message)}
		{@const type = getStardustType(message)}
		{#if type === 'lifecycle'}
			{@const status = (message.metadata['stardust:status'] as string) ?? ''}
			{@const reason = (message.metadata['stardust:reason'] as string) ?? ''}
			<div
				class="lifecycle-marker"
				class:lifecycle-terminal={status === 'complete'}
				class:lifecycle-failed={status === 'failed'}
				class:lifecycle-cancelled={status === 'cancelled'}
				role="status"
				aria-label="Run {status}"
			>
				<span class="lifecycle-dot"></span>
				<span class="lifecycle-label">Run {status}</span>
				{#if status === 'failed' && reason}
					<span class="lifecycle-reason">{reason}</span>
				{/if}
				{#if status === 'failed' && onRetry}
					<button class="lifecycle-retry" onclick={() => onRetry?.()}>Retry</button>
				{/if}
			</div>
		{:else if type === 'subagent'}
			{@const subStatus = (message.metadata['stardust:status'] as string) ?? 'running'}
			{@const label = (message.metadata['stardust:subagentLabel'] as string) ?? ''}
			{@const kind = (message.metadata['stardust:subagentKind'] as string) ?? ''}
			<div class="subagent-lane" data-status={subStatus} aria-label="Subagent: {label}">
				{#if kind}
					<span class="subagent-kind">{kind}</span>
				{/if}
				<span class="subagent-label">{label}</span>
				<span class="subagent-status">{subStatus}</span>
			</div>
		{:else if type === 'memory-candidate'}
			<div class="memory-notice" aria-label="Memory candidate">
				<span class="memory-icon">🧠</span>
				<span class="memory-content"
					>{typeof message.content === 'string' ? message.content : ''}</span
				>
			</div>
		{:else if type === 'approval-request'}
			{@const toolName = (message.metadata['stardust:toolName'] as string) ?? 'unknown'}
			<div class="approval-notice" role="alert" aria-label="Approval required: {toolName}">
				<span class="approval-icon">⏳</span>
				<span>Waiting for approval: <strong>{toolName}</strong></span>
			</div>
		{:else}
			{@render renderDefault()}
		{/if}
	{:else}
		{@render renderDefault()}
	{/if}
{/snippet}

<div class="conversation-chat" aria-label="Conversation">
	<Chat
		id="session-{sessionId}"
		{conversation}
		streaming={running}
		streamingStatus="Thinking…"
		variant="flat"
		density="comfortable"
		surfaceMode="transparent"
		capabilities={{
			attachments: false,
			search: false,
			copy: true,
			editing: false,
			retry: !!onRetry
		}}
		onsubmit={handleSubmit}
		onretry={handleRetry}
		onstopgenerating={handleStopGenerating}
		row={stardustRow}
	/>
</div>

<style>
	.conversation-chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	/* Stardust-specific row styles */

	.lifecycle-marker {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--cinder-text-xs);
		color: var(--cinder-text-subtle);
		padding: 4px 16px;
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

	.lifecycle-failed .lifecycle-dot {
		background: var(--cinder-danger);
	}

	.lifecycle-cancelled .lifecycle-dot {
		background: var(--cinder-warning);
	}

	.lifecycle-label {
		font-size: var(--cinder-text-xs);
		text-transform: capitalize;
	}

	.lifecycle-reason {
		color: var(--cinder-color-danger-fg);
		word-break: break-word;
	}

	.lifecycle-retry {
		margin-left: auto;
		padding: 2px 10px;
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-sm);
		background: var(--cinder-surface);
		color: var(--cinder-text);
		cursor: pointer;
	}

	.lifecycle-retry:hover {
		background: var(--cinder-surface-hover);
	}

	.subagent-lane {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		margin: 0 16px;
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

	.approval-notice {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		margin: 0 16px;
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
		margin: 0 16px;
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
</style>
