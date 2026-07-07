<script lang="ts" module>
	import type { ApprovalOperation } from '@lostgradient/cinder/approval-card';

	/** Build a Cinder ApprovalOperation from a pending approval's tool call. */
	export function toApprovalOperation(toolCall: {
		name: string;
		arguments: unknown;
	}): ApprovalOperation {
		const args = toolCall.arguments;
		if (typeof args === 'object' && args !== null) {
			const obj = args as Record<string, unknown>;
			if (typeof obj.command === 'string') {
				return { kind: 'command', command: obj.command, argsPreview: args };
			}
			if (typeof obj.cmd === 'string') {
				return { kind: 'command', command: obj.cmd, argsPreview: args };
			}
		}
		return { kind: 'other', argsPreview: args };
	}
</script>

<script lang="ts">
	import Chat from '@lostgradient/cinder/chat';
	import type { ChatSubmitEvent, Message } from '@lostgradient/cinder/chat';
	import ApprovalCard from '@lostgradient/cinder/approval-card';
	import {
		applyNewStreamEvents,
		createConversationBuilder,
		snapshotConversation,
		type ConversationBuilderState,
		type StreamEvent,
		type UserMessage
	} from '$lib/stream-to-conversation';
	import type { PendingApprovalEntry } from '$lib/types';

	type Props = {
		sessionId: string;
		userMessage?: UserMessage | null;
		events?: StreamEvent[];
		running?: boolean;
		onSubmit: (message: string) => void;
		onRetry?: (() => void) | null;
		onSteer?: (message: string) => void;
		onInterrupt?: () => void;
		/** Replay cursor — rows with a durable sequence above this dim out. Null means live. */
		dimAfterSequence?: number | null;
		/** The session's pending approval, rendered as an inline ApprovalCard. */
		pendingApproval?: PendingApprovalEntry | null;
		/** How the last approval was resolved, for the card's settled state. */
		approvalResolution?: 'approve' | 'deny' | null;
		onResolveApproval?: (
			approvalId: string,
			action: 'approve' | 'approve_with_edits' | 'deny',
			editedArguments?: unknown
		) => void;
	};

	let {
		sessionId,
		userMessage = null,
		events = [],
		running = false,
		onSubmit,
		onRetry = null,
		onSteer,
		onInterrupt,
		dimAfterSequence = null,
		pendingApproval = null,
		approvalResolution = null,
		onResolveApproval
	}: Props = $props();

	// Non-reactive fold cache: `buildConversation` re-walking the entire event
	// history on every streamed token is O(n²) over the life of a run. Instead,
	// hold a plain (not `$state`) builder that carries the fold cursor across
	// derivations, and only re-fold from scratch when the events array isn't a
	// prefix-extension of what we last saw (session switch, transcript reload).
	let builderState: ConversationBuilderState | null = null;
	let cachedEvents: StreamEvent[] = [];
	let cachedSessionId: string | null = null;
	let cachedUserMessage: UserMessage | null = null;

	function isPrefixExtension(previous: StreamEvent[], next: StreamEvent[]): boolean {
		if (next.length < previous.length) return false;
		for (let i = 0; i < previous.length; i++) {
			if (previous[i] !== next[i]) return false;
		}
		return true;
	}

	const conversation = $derived.by(() => {
		const needsReset =
			builderState === null ||
			cachedSessionId !== sessionId ||
			cachedUserMessage !== userMessage ||
			!isPrefixExtension(cachedEvents, events);

		if (needsReset) {
			builderState = createConversationBuilder(sessionId, userMessage);
			cachedSessionId = sessionId;
			cachedUserMessage = userMessage;
		}

		// `needsReset` guarantees `builderState` was just (re)created if it was ever
		// null — the non-null assertion just tells TypeScript what the runtime
		// control flow already established.
		const state: ConversationBuilderState = builderState!;
		applyNewStreamEvents(state, events);
		cachedEvents = events;
		return snapshotConversation(state);
	});

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
	 * lifecycle markers, memory candidates, inline approvals). Cinder's default
	 * row handles user, assistant, tool-call, and tool-result natively.
	 */
	function isStardustSystemMessage(message: Message): boolean {
		return 'stardust:type' in message.metadata;
	}

	function getStardustType(message: Message): string {
		return (message.metadata['stardust:type'] as string) ?? '';
	}

	function isDimmed(message: Message): boolean {
		if (dimAfterSequence === null) return false;
		const sequence = message.metadata['stardust:sequence'];
		return typeof sequence === 'number' && sequence > dimAfterSequence;
	}

	/**
	 * BUG-004: the inline ApprovalCard has no dedicated announcement distinct
	 * from the transcript's own generic `aria-live="polite"` growth cue. This
	 * derives a polite, higher-signal announcement text keyed to the pending
	 * approval so screen-reader users learn an action is required as soon as
	 * one appears, without stealing focus from wherever they were reading.
	 */
	const approvalAnnouncement = $derived(
		pendingApproval ? `Approval required: ${pendingApproval.toolCall.name}` : ''
	);
</script>

{#snippet stardustRow(message: Message, renderDefault: import('svelte').Snippet)}
	<div class="row-shell" class:row-dimmed={isDimmed(message)}>
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
					<!-- lucide brain -->
					<svg
						class="memory-icon"
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path
							d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"
						/>
						<path
							d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"
						/>
						<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
					</svg>
					<span class="memory-content"
						>{typeof message.content === 'string' ? message.content : ''}</span
					>
				</div>
			{:else if type === 'approval-request'}
				{@const toolName = (message.metadata['stardust:toolName'] as string) ?? 'unknown'}
				{@const transcriptResolution = message.metadata['stardust:resolution'] as
					| string
					| undefined}
				{#if transcriptResolution}
					<div
						class="approval-settled"
						class:approval-denied={transcriptResolution === 'deny'}
						role="status"
					>
						{transcriptResolution === 'deny'
							? 'Denied — the run was told no and is wrapping up safely'
							: `Approved — the signal woke the workflow and ${toolName} ran`}
					</div>
				{:else if pendingApproval && onResolveApproval}
					{@const approval = pendingApproval}
					<div class="inline-approval">
						<ApprovalCard
							tool={{ name: approval.toolCall.name, risk: 'high' }}
							operation={toApprovalOperation(approval.toolCall)}
							policyVersion="policy-2026-06"
							idempotencyKey={approval.approvalId}
							expiresAt={approval.expiresAt}
							state="pending"
							editableArgs={true}
							onapprove={() => onResolveApproval(approval.approvalId, 'approve')}
							ondeny={() => onResolveApproval(approval.approvalId, 'deny')}
							onapprovewithedits={(editedArguments) =>
								onResolveApproval(approval.approvalId, 'approve_with_edits', editedArguments)}
						/>
						<p class="inline-approval-note">
							Approve here or from the Inbox — either way it is the same durable signal to the same
							workflow.
						</p>
					</div>
				{:else if approvalResolution}
					<div
						class="approval-settled"
						class:approval-denied={approvalResolution === 'deny'}
						role="status"
					>
						{approvalResolution === 'approve'
							? `Approved — the signal woke the workflow and ${toolName} is running`
							: 'Denied — the run was told no and is wrapping up safely'}
					</div>
				{:else}
					<div class="approval-notice" role="alert" aria-label="Approval required: {toolName}">
						<span>Waiting for approval: <strong>{toolName}</strong></span>
					</div>
				{/if}
			{:else}
				{@render renderDefault()}
			{/if}
		{:else}
			{@render renderDefault()}
		{/if}
	</div>
{/snippet}

<div class="conversation-chat" aria-label="Conversation">
	<div class="visually-hidden" aria-live="polite" aria-atomic="true">
		{approvalAnnouncement}
	</div>
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
		width: 100%;
		max-width: 760px;
		margin: 0 auto;
		overflow: hidden;
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

	/* Stardust-specific row styles */

	.row-shell {
		transition: opacity 0.2s ease;
	}

	.row-dimmed {
		opacity: 0.25;
		filter: saturate(0.4);
		pointer-events: none;
	}

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

	.inline-approval {
		margin: 0 16px;
		max-width: 560px;
	}

	.inline-approval-note {
		margin: 6px 0 0;
		font-size: 11px;
		line-height: 1.5;
		color: var(--cinder-text-subtle);
	}

	.approval-settled {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		margin: 0 16px;
		border: 1px solid var(--cinder-color-success-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-color-success-bg);
		color: var(--cinder-color-success-fg);
		font-size: var(--cinder-text-xs);
		font-weight: 600;
	}

	.approval-settled.approval-denied {
		border-color: var(--cinder-border-muted);
		background: var(--cinder-surface-inset);
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
