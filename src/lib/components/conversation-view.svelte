<script lang="ts" module>
	import type { ApprovalOperation } from '@lostgradient/cinder/approval-card';
	import type { ChatAttachment } from '@lostgradient/cinder/chat';
	import type { SessionAttachmentInput } from '$lib/types';

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

	/** Base64-encode a File's raw bytes without blowing the call stack on large files. */
	async function fileToBase64(file: File): Promise<string> {
		const buffer = await file.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const CHUNK_SIZE = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
		}
		return btoa(binary);
	}

	/** Convert Cinder's composer attachments into Stardust's turn-submission payload. */
	export async function chatAttachmentsToSessionAttachments(
		attachments: ChatAttachment[]
	): Promise<SessionAttachmentInput[]> {
		return Promise.all(
			attachments.map(async (attachment) => ({
				name: attachment.file.name,
				mimeType: attachment.file.type || 'application/octet-stream',
				kind: attachment.kind,
				content: await fileToBase64(attachment.file)
			}))
		);
	}
</script>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import Chat from '@lostgradient/cinder/chat';
	import type { ChatSubmitEvent, Message } from '@lostgradient/cinder/chat';
	import ApprovalCard from '@lostgradient/cinder/approval-card';
	import CommandItem from '@lostgradient/cinder/command-item';
	import CommandMenu from '@lostgradient/cinder/command-menu';
	import type { CommandMenuState } from '@lostgradient/cinder/command-menu';
	import {
		applyNewStreamEvents,
		createConversationBuilder,
		snapshotConversation,
		type ConversationBuilderState,
		type StreamEvent,
		type UserMessage
	} from '$lib/stream-to-conversation';
	import type { PendingApprovalEntry } from '$lib/types';
	import {
		createDefaultSlashCommands,
		filterSlashCommands,
		type SlashCommand,
		type SlashCommandContext
	} from '$lib/slash-commands';

	type Props = {
		sessionId: string;
		userMessage?: UserMessage | null;
		events?: StreamEvent[];
		running?: boolean;
		onSubmit: (message: string, attachments?: SessionAttachmentInput[]) => void;
		onRetry?: (() => void) | null;
		onSteer?: (message: string) => void;
		onInterrupt?: () => void;
		/**
		 * Called when the user edits a past user message and saves it. The durable
		 * transcript is append-only — there is no rewind primitive — so an edit is
		 * submitted as a brand-new turn with the corrected text rather than
		 * rewriting history. When omitted, editing is disabled entirely.
		 */
		onEdit?: (content: string) => void;
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
		onEdit,
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

	// Compares event ids, not object identity: `events` arrives $state-proxied
	// while the cache holds earlier snapshots, so `!==` across that boundary is
	// unreliable (and triggers Svelte's state_proxy_equality_mismatch warning).
	// Event rows are immutable once emitted, so a matching id at every prior
	// position means `next` is `previous` plus appended events.
	function isPrefixExtension(previous: StreamEvent[], next: StreamEvent[]): boolean {
		if (next.length < previous.length) return false;
		for (let i = 0; i < previous.length; i++) {
			if (previous[i].id !== next[i].id) return false;
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

	// ---- Slash commands (BUG-002) ----------------------------------------
	// Cinder exposes the composer value, keydown hook, and combobox ARIA props,
	// so Stardust keeps slash-command behavior on the public Chat contract.

	const slashListboxId = $derived(`session-${sessionId}-slash`);
	const allSlashCommands = createDefaultSlashCommands();

	let chatRef = $state<ReturnType<typeof Chat> | undefined>();
	let slashOpen = $state(false);
	let slashQuery = $state('');
	let slashAnchor = $state<HTMLTextAreaElement | null>(null);
	let slashCaretIndex = $state(0);
	let slashActiveItemId = $state<string | null>(null);
	let slashInfo = $state<{ title: string; lines: string[] } | null>(null);
	let lastApprovalAnnouncement = '';

	const filteredSlashCommands = $derived(filterSlashCommands(allSlashCommands, slashQuery));
	const composerAriaActiveDescendant = $derived(
		slashOpen ? (slashActiveItemId ?? undefined) : undefined
	);

	const slashContext = $derived<SlashCommandContext>({
		running,
		hasRetry: !!onRetry,
		hasPendingApproval: pendingApproval !== null,
		onInterrupt: () => onInterrupt?.(),
		onRetry: () => onRetry?.(),
		createSession: async () => {
			const response = await fetch('/api/sessions', { method: 'POST' });
			if (!response.ok) throw new Error('Failed to create session');
			const body = (await response.json()) as { sessionKey: string };
			await goto(resolve(`/sessions/${encodeURIComponent(body.sessionKey)}`));
			return body.sessionKey;
		},
		openApprovals: () => {
			void goto(resolve('/inbox'));
		},
		listTools: async () => {
			const response = await fetch('/api/tools');
			if (!response.ok) return [];
			const body = (await response.json()) as {
				tools: Array<{ name: string; description: string; risk: string }>;
			};
			return body.tools;
		},
		listCommands: () =>
			allSlashCommands.map((command) => ({ name: command.name, description: command.description }))
	});

	function openSlash(): void {
		slashOpen = true;
		slashQuery = '';
		slashActiveItemId = null;
		slashInfo = null;
	}

	function closeSlash(options: { clearText?: boolean; refocus?: boolean } = {}): void {
		slashOpen = false;
		slashQuery = '';
		slashActiveItemId = null;
		if (options.clearText) chatRef?.clearInput();
		if (options.refocus) chatRef?.focusInput();
	}

	async function executeSlashCommand(command: SlashCommand): Promise<void> {
		const reason = command.unavailable(slashContext);
		if (reason) {
			slashInfo = { title: command.name, lines: [reason] };
			closeSlash({ clearText: true });
			return;
		}
		const outcome = await command.run(slashContext);
		slashInfo = outcome.kind === 'info' ? { title: outcome.title, lines: outcome.lines } : null;
		closeSlash({ clearText: true, refocus: true });
	}

	/** A single-line message that starts with `/` and has no space yet is a slash-command prefix. */
	function isSlashTriggerText(text: string): boolean {
		return text.startsWith('/') && !text.includes('\n') && !text.includes(' ');
	}

	/**
	 * Fired on every composer text change via Cinder's `oncomposerinput` prop
	 * (0.8.0+) — replaces the previous DOM-level manual `.value`/`.textContent`
	 * read.
	 */
	function syncSlashAnchor(event?: Event): HTMLTextAreaElement | null {
		const eventTarget = event?.currentTarget ?? event?.target;
		const editor =
			eventTarget instanceof HTMLTextAreaElement
				? eventTarget
				: (chatRef?.getEditorElement() ?? null);
		if (!editor) return null;

		slashAnchor = editor;
		slashCaretIndex = editor.selectionStart ?? editor.value.length;
		return editor;
	}

	function handleComposerInput(text: string, event?: Event): void {
		syncSlashAnchor(event);
		if (slashOpen) {
			if (isSlashTriggerText(text)) {
				slashQuery = text.slice(1);
				slashActiveItemId = null;
			} else {
				closeSlash();
			}
		} else if (isSlashTriggerText(text)) {
			openSlash();
			slashQuery = text.slice(1);
		}
	}

	function handleComposerSelectionChange(event: Event): void {
		syncSlashAnchor(event);
	}

	function handleComposerKeydown(event: KeyboardEvent): void {
		if (!slashOpen) return;

		if (event.key === 'Escape') {
			// CommandMenu owns dismissal. Stardust only preserves the existing
			// composer contract that Escape also clears the slash prefix.
			chatRef?.clearInput();
		} else if (event.key === 'Enter' && slashActiveItemId === null) {
			// CommandMenu intentionally leaves Enter alone when it has no enabled
			// item. Consume it here so Chat does not submit an unavailable command.
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function handleSlashMenuState(state: CommandMenuState): void {
		slashActiveItemId = state.activeItemId;
	}

	$effect(() => {
		const announcement = pendingApproval
			? `Approval required: ${pendingApproval.toolCall.name}`
			: '';
		if (!announcement) {
			lastApprovalAnnouncement = '';
			return;
		}
		if (!chatRef || announcement === lastApprovalAnnouncement) return;

		let cancelled = false;
		void tick().then(() => {
			if (cancelled || !chatRef || announcement === lastApprovalAnnouncement) return;
			chatRef.announce(announcement, 'polite');
			lastApprovalAnnouncement = announcement;
		});

		return () => {
			cancelled = true;
		};
	});

	async function handleSubmit(event: ChatSubmitEvent) {
		const content = event.message.content;
		const text = typeof content === 'string' ? content : '';
		const trimmed = text.trim();
		if (!trimmed && event.attachments.length === 0) return;

		if (running && onSteer) {
			// Steering an in-flight run has no attachment path — the sandbox tool
			// call that would consume a file is already mid-run.
			if (trimmed) onSteer(trimmed);
			return;
		}

		const attachments =
			event.attachments.length > 0
				? await chatAttachmentsToSessionAttachments(event.attachments)
				: undefined;
		onSubmit(trimmed, attachments);
	}

	function handleRetry() {
		onRetry?.();
	}

	function handleStopGenerating() {
		onInterrupt?.();
	}

	function handleEdit(event: { messageId: string; content: string }) {
		onEdit?.(event.content);
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
							onresolve={(resolution) => {
								if (resolution.decision === 'cancel') return;
								if (resolution.decision === 'approve_with_edits') {
									onResolveApproval(
										approval.approvalId,
										resolution.decision,
										resolution.editedArgs
									);
								} else {
									onResolveApproval(approval.approvalId, resolution.decision);
								}
							}}
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
	<div class="slash-anchor">
		<CommandMenu
			bind:open={slashOpen}
			bind:query={slashQuery}
			listboxId={slashListboxId}
			anchor={slashAnchor}
			caretIndex={slashCaretIndex}
			placement="top-start"
			label="Slash commands"
			onselect={({ value }) => {
				const command = allSlashCommands.find((candidate) => candidate.id === value);
				if (command) void executeSlashCommand(command);
			}}
			ondismiss={closeSlash}
			onstatechange={handleSlashMenuState}
		>
			{#snippet items()}
				{#each filteredSlashCommands as command (command.id)}
					{@const reason = command.unavailable(slashContext)}
					<CommandItem
						value={command.id}
						description={reason ?? command.description}
						accessibleLabel={`${command.name}: ${reason ?? command.description}`}
						disabled={reason !== null}
						selectionMode="parent"
					>
						{command.name}
					</CommandItem>
				{/each}
			{/snippet}

			{#snippet empty()}
				No matching commands
			{/snippet}
		</CommandMenu>
		{#if slashInfo}
			<div class="slash-info" role="status">
				<div class="slash-info-header">
					<strong>{slashInfo.title}</strong>
					<button
						type="button"
						class="slash-info-dismiss"
						aria-label="Dismiss"
						onclick={() => (slashInfo = null)}
					>
						×
					</button>
				</div>
				<ul>
					{#each slashInfo.lines as line, index (index)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
	<Chat
		bind:this={chatRef}
		id="session-{sessionId}"
		{conversation}
		streaming={running}
		streamingStatus="Thinking…"
		variant="flat"
		density="comfortable"
		surfaceMode="transparent"
		capabilities={{
			attachments: true,
			search: false,
			copy: true,
			editing: !!onEdit,
			retry: !!onRetry
		}}
		onsubmit={handleSubmit}
		onretry={handleRetry}
		onedit={handleEdit}
		onstopgenerating={handleStopGenerating}
		oncomposerinput={handleComposerInput}
		oncomposerkeydown={handleComposerKeydown}
		oncomposerselectionchange={handleComposerSelectionChange}
		oncomposerblur={() => closeSlash()}
		composerRole="combobox"
		composerAriaExpanded={slashOpen ? 'true' : 'false'}
		composerAriaControls={slashOpen ? slashListboxId : undefined}
		{composerAriaActiveDescendant}
		composerAriaAutocomplete={slashOpen ? 'list' : undefined}
		row={stardustRow}
	/>
</div>

<style>
	.conversation-chat {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		width: 100%;
		max-width: 760px;
		margin: 0 auto;
		overflow: hidden;
	}

	.slash-anchor {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 84px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		pointer-events: none;
	}

	.slash-anchor > :global(*) {
		pointer-events: auto;
	}

	.slash-info {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-elevated, var(--cinder-surface));
		box-shadow: var(--cinder-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.24));
		padding: 10px 12px;
		font-size: var(--cinder-text-sm);
	}

	.slash-info-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.slash-info-dismiss {
		border: none;
		background: none;
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-md, 16px);
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
	}

	.slash-info ul {
		margin: 8px 0 0;
		padding-left: 18px;
		color: var(--cinder-text-subtle);
	}

	.slash-info li {
		font-family: var(--cinder-font-mono);
		font-size: var(--cinder-text-xs);
		margin-bottom: 4px;
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
