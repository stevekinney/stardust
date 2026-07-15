/**
 * Transforms Stardust's SSE StreamEvent[] into Cinder's ConversationHistory.
 *
 * This is the adapter between Stardust's real-time event model and the
 * immutable conversation snapshot that Cinder's Chat component renders.
 *
 * The conversation container is built with conversationalist's own primitives
 * (`createConversationHistory` / `appendUnsafeMessage` — Cinder re-exports the
 * conversation types 1:1 from that package), so message construction, ids,
 * positions, and immutability are owned upstream. Appends deliberately use the
 * unvalidated primitive: this render fold legitimately produces conversations
 * the validated layer rejects as `integrity:orphan-tool-result` — approval
 * placeholders carry synthetic `callId`s (the approval id), and a mid-flight
 * transcript window can contain a `tool.result` whose call fell outside the
 * window. For the same reason the `conversationalist/streaming` trio
 * (`appendStreamingMessage` et al.) is unusable here — every variant re-runs
 * full validation — so streamed-delta content replacement stays a local
 * immutable update (upstream: stevekinney/agent-bureau#156). The incremental
 * `processedCount` cursor also stays local until the upstream projection
 * primitive ships (stevekinney/agent-bureau#152).
 */

import type {
	ConversationHistory,
	JSONValue,
	MessageInput,
	MultiModalContent,
	ToolCall,
	ToolResult
} from '@lostgradient/cinder/chat';
import type { ConversationEnvironment } from 'conversationalist';
import { appendUnsafeMessage, createConversationHistory } from 'conversationalist';
import type { SessionAttachmentInput } from '$lib/types';

/** A normalized stream event as produced by the SSE endpoint. */
export type StreamEvent = {
	id: number;
	kind: string;
	payload: string;
	/**
	 * Durable transcript sequence, present when the event was rebuilt from the
	 * canonical transcript. Live SSE frames have no sequence. Drives the replay
	 * scrubber's row dimming via `stardust:sequence` message metadata.
	 */
	sequence?: number;
};

/** A user message rendered before the stream (the turn that started the run). */
export type UserMessage = {
	text: string;
	/**
	 * Files attached to this turn. Rendering-only — this is NOT persisted to the
	 * durable transcript, so attachments only render for the live/current turn.
	 * After a reload, `loadTranscript()` rebuilds `UserMessage` from the durable
	 * `user_message` event, which carries text only, so the attachment preview
	 * does not survive a reload (documented, deliberate scope boundary).
	 */
	attachments?: SessionAttachmentInput[];
};

/** A raw row as returned by `GET /api/sessions/{sessionKey}/transcript`. */
export type TranscriptEventRow = {
	id: string;
	runId: string;
	kind: string;
	payload: string;
	sequence: number;
};

/**
 * Builds Cinder `MultiModalContent[]` for a user message with attachments.
 * Images render as real inline previews via Cinder's native image content
 * part. Code/document attachments have no equivalent inline-preview content
 * type in Cinder's model, so they render as a plain text reference instead.
 */
function buildAttachmentContent(
	text: string,
	attachments: SessionAttachmentInput[]
): MultiModalContent[] {
	const parts: MultiModalContent[] = [];
	if (text) parts.push({ type: 'text', text });
	for (const attachment of attachments) {
		if (attachment.kind === 'image') {
			parts.push({
				type: 'image',
				url: `data:${attachment.mimeType};base64,${attachment.content}`,
				mimeType: attachment.mimeType,
				text: attachment.name
			});
		} else {
			parts.push({ type: 'text', text: `📎 Attached: ${attachment.name}` });
		}
	}
	return parts;
}

/** Maps durable transcript event kinds to the live-stream `StreamEvent['kind']` vocabulary. */
const TRANSCRIPT_KIND_MAP: Record<string, string> = {
	user_message: 'user.message',
	assistant_message: 'assistant.message',
	tool_result: 'tool.result',
	approval_request: 'approval.request',
	approval_resolution: 'approval.resolution',
	lifecycle: 'lifecycle'
};

/**
 * Rebuilds `StreamEvent[]` from the canonical transcript returned by the
 * transcript endpoint. This is the single mapping used both on initial mount
 * (rehydration after a refresh) and whenever the transcript is refetched —
 * `tool_call` rows are fanned out into one `tool.call` StreamEvent per call,
 * sharing the parent row's durable sequence so replay dimming stays
 * consistent per batch. All other kinds pass through `TRANSCRIPT_KIND_MAP`.
 */
export function mapTranscriptToStreamEvents(rows: TranscriptEventRow[]): StreamEvent[] {
	let sequenceCounter = 0;
	return rows.flatMap((row): StreamEvent[] => {
		if (row.kind === 'tool_call') {
			try {
				const parsed = JSON.parse(row.payload) as {
					calls?: Array<{ id: string; name: string; input: unknown }>;
				};
				return (parsed.calls ?? []).map((call) => ({
					id: sequenceCounter++,
					kind: 'tool.call',
					payload: JSON.stringify({ id: call.id, name: call.name, input: call.input }),
					sequence: row.sequence
				}));
			} catch {
				return [];
			}
		}
		return [
			{
				id: sequenceCounter++,
				kind: TRANSCRIPT_KIND_MAP[row.kind] ?? row.kind,
				payload: row.payload,
				sequence: row.sequence
			}
		];
	});
}

/** Finds the text of the most recent `user_message` transcript row, if any. */
export function findLastUserMessageText(rows: TranscriptEventRow[]): string | null {
	const userMessageRows = rows.filter((row) => row.kind === 'user_message');
	if (userMessageRows.length === 0) return null;
	const last = userMessageRows[userMessageRows.length - 1];
	try {
		const parsed = JSON.parse(last.payload) as { text?: string };
		return parsed.text ?? null;
	} catch {
		return null;
	}
}

/**
 * Mutable fold state behind the incremental conversation builder. Treat this
 * as an opaque handle: construct it with `createConversationBuilder`, feed it
 * new events with `applyNewStreamEvents`, and read a snapshot with
 * `snapshotConversation`.
 */
export type ConversationBuilderState = {
	/** The conversationalist-built conversation the fold appends into. */
	conversation: ConversationHistory;
	/** Fixed fold timestamp injected as the conversationalist environment clock. */
	now: string;
	assistantTextAccumulator: string;
	assistantMessageId: string | null;
	/** Count of events (from the cumulative stream) already folded into this state. */
	processedCount: number;
};

/**
 * Deterministic conversationalist environment for one append: a fixed clock
 * (all messages in a fold share `state.now`, keeping the pure rebuild and the
 * incremental path byte-identical) and position-derived message ids
 * (`msg-<position>`), so ids are stable across rebuilds instead of random.
 */
function appendEnvironment(state: ConversationBuilderState): Partial<ConversationEnvironment> {
	const id = `msg-${state.conversation.ids.length}`;
	return { now: () => state.now, randomId: () => id };
}

/**
 * Appends one message through conversationalist, attaching the durable
 * transcript sequence as `stardust:sequence` metadata when present. Returns
 * the new message's id.
 */
function appendMessage(
	state: ConversationBuilderState,
	input: MessageInput,
	sequence?: number
): string {
	state.conversation = appendUnsafeMessage(
		state.conversation,
		{
			...input,
			metadata: {
				...(input.metadata ?? {}),
				...(sequence !== undefined ? { 'stardust:sequence': sequence } : {})
			}
		},
		appendEnvironment(state)
	);
	return state.conversation.ids[state.conversation.ids.length - 1];
}

/**
 * Replaces a message's content in place (immutably) — the streamed-delta
 * update. conversationalist's `updateStreamingMessage` is the matching
 * primitive but re-validates the whole conversation on every call, which
 * throws once an approval placeholder (synthetic `callId`, so an orphan
 * tool-result by design) is present; see stevekinney/agent-bureau#156.
 */
function replaceMessageContent(
	state: ConversationBuilderState,
	messageId: string,
	content: string
): void {
	const original = state.conversation.messages[messageId];
	state.conversation = {
		...state.conversation,
		messages: { ...state.conversation.messages, [messageId]: { ...original, content } }
	};
}

/**
 * Creates a fresh conversation fold, seeded with the leading user message (if
 * any). Pass the returned state to `applyNewStreamEvents` as events arrive.
 */
export function createConversationBuilder(
	sessionId: string,
	userMessage: UserMessage | null
): ConversationBuilderState {
	const now = new Date().toISOString();
	const state: ConversationBuilderState = {
		conversation: createConversationHistory({ id: sessionId }, { now: () => now }),
		now,
		assistantTextAccumulator: '',
		assistantMessageId: null,
		processedCount: 0
	};

	if (userMessage) {
		const content =
			userMessage.attachments && userMessage.attachments.length > 0
				? buildAttachmentContent(userMessage.text, userMessage.attachments)
				: userMessage.text;
		appendMessage(state, { role: 'user', content });
	}

	return state;
}

/**
 * Folds only the events past `state.processedCount` into the builder state.
 *
 * `events` is always the *cumulative* stream — Stardust appends to it rather
 * than emitting deltas-of-deltas — so this is safe to call repeatedly with
 * the growing array. Each call does O(new events) work instead of re-folding
 * the whole history, which is what makes it safe to invoke on every streamed
 * token without O(n²) blowup over the life of a run.
 *
 * `onEventProcessed`, if given, fires once per event actually folded — tests
 * use it to prove the incremental path only touches new events instead of
 * re-walking history.
 */
export function applyNewStreamEvents(
	state: ConversationBuilderState,
	events: StreamEvent[],
	onEventProcessed?: (event: StreamEvent) => void
): void {
	for (let i = state.processedCount; i < events.length; i++) {
		const event = events[i];
		onEventProcessed?.(event);

		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(event.payload) as Record<string, unknown>;
		} catch {
			continue;
		}

		switch (event.kind) {
			case 'user.message': {
				// A user message opens a new turn. Reset the assistant accumulator so this
				// turn's reply becomes its own message instead of overwriting the previous
				// turn's — this is what makes the transcript render as a multi-turn chat.
				state.assistantMessageId = null;
				state.assistantTextAccumulator = '';
				const text = (payload.text as string) ?? '';
				// Attachments only ever appear on the live-seeded event the session page
				// synthesizes for the turn just submitted (see handleSubmit) — never on
				// events rebuilt from the durable transcript, which stores text only.
				const attachments = Array.isArray(payload.attachments)
					? (payload.attachments as SessionAttachmentInput[])
					: undefined;
				const content =
					attachments && attachments.length > 0 ? buildAttachmentContent(text, attachments) : text;
				appendMessage(state, { role: 'user', content }, event.sequence);
				break;
			}

			case 'assistant.delta': {
				state.assistantTextAccumulator += (payload.text as string) ?? '';
				if (state.assistantMessageId && state.conversation.messages[state.assistantMessageId]) {
					replaceMessageContent(state, state.assistantMessageId, state.assistantTextAccumulator);
				} else {
					state.assistantMessageId = appendMessage(
						state,
						{ role: 'assistant', content: state.assistantTextAccumulator },
						event.sequence
					);
				}
				break;
			}

			case 'assistant.message': {
				const text = (payload.text as string) ?? '';
				state.assistantTextAccumulator = text;
				if (state.assistantMessageId && state.conversation.messages[state.assistantMessageId]) {
					replaceMessageContent(state, state.assistantMessageId, text);
				} else {
					state.assistantMessageId = appendMessage(
						state,
						{ role: 'assistant', content: text },
						event.sequence
					);
				}
				break;
			}

			case 'tool.call': {
				// A tool call breaks the assistant's turn: any assistant text that
				// follows the tool result is a distinct message that must render *below*
				// the tool call/result rows, not fold back into the pre-tool bubble
				// above them. Reset the accumulator so the post-tool reply starts fresh.
				state.assistantMessageId = null;
				state.assistantTextAccumulator = '';
				const toolCall: ToolCall = {
					id: payload.id as string,
					name: payload.name as string,
					arguments: (payload.input as JSONValue) ?? {}
				};
				appendMessage(
					state,
					{
						role: 'tool-call',
						content: `Tool call: ${toolCall.name}`,
						toolCall
					},
					event.sequence
				);
				break;
			}

			case 'tool.result': {
				const outcome = (payload.isError as boolean) ? 'error' : 'success';
				const toolResult: ToolResult = {
					callId: payload.callId as string,
					outcome,
					content: (payload.content as JSONValue) ?? ''
				};
				appendMessage(
					state,
					{
						role: 'tool-result',
						content: `Tool result: ${outcome}`,
						toolResult
					},
					event.sequence
				);
				break;
			}

			case 'approval.request': {
				const approvalToolCallId = (payload.approvalId as string) ?? '';
				// Live stream frames carry a flat toolName; canonical transcript
				// events nest it under toolCall.name.
				const toolName =
					(payload.toolName as string) ??
					((payload.toolCall as { name?: string } | undefined)?.name || 'unknown');
				const toolResult: ToolResult = {
					callId: approvalToolCallId,
					outcome: 'action_required',
					content: `Waiting for approval: ${toolName}`,
					action: {
						type: 'approval',
						message: `Approve tool call: ${toolName}`
					}
				};
				appendMessage(
					state,
					{
						role: 'tool-result',
						content: `Approval required: ${toolName}`,
						toolResult,
						metadata: {
							'stardust:type': 'approval-request',
							'stardust:toolName': toolName,
							'stardust:approvalId': (payload.approvalId as string) ?? ''
						}
					},
					event.sequence
				);
				break;
			}

			case 'approval.resolution': {
				// Mark the matching approval-request message as settled so the row
				// renders a resolved banner instead of a stale waiting notice.
				const approvalId = (payload.approvalId as string) ?? '';
				const action = (payload.action as string) ?? 'approve';
				let messages = state.conversation.messages;
				let changed = false;
				for (const id of state.conversation.ids) {
					const candidate = messages[id];
					if (
						candidate.metadata['stardust:type'] === 'approval-request' &&
						candidate.metadata['stardust:approvalId'] === approvalId
					) {
						messages = {
							...messages,
							[id]: {
								...candidate,
								metadata: { ...candidate.metadata, 'stardust:resolution': action }
							}
						};
						changed = true;
					}
				}
				if (changed) {
					state.conversation = { ...state.conversation, messages };
				}
				break;
			}

			case 'subagent.start': {
				appendMessage(
					state,
					{
						role: 'system',
						content: `Subagent started: ${(payload.label as string) ?? ''}`,
						metadata: {
							'stardust:type': 'subagent',
							'stardust:status': 'running',
							'stardust:subagentRunId': (payload.subagentRunId as string) ?? '',
							'stardust:subagentKind': (payload.kind as string) ?? '',
							'stardust:subagentLabel': (payload.label as string) ?? ''
						}
					},
					event.sequence
				);
				break;
			}

			case 'subagent.complete': {
				appendMessage(
					state,
					{
						role: 'system',
						content: `Subagent complete: ${(payload.subagentRunId as string) ?? ''}`,
						metadata: {
							'stardust:type': 'subagent',
							'stardust:status': (payload.status as string) ?? 'complete',
							'stardust:subagentRunId': (payload.subagentRunId as string) ?? ''
						}
					},
					event.sequence
				);
				break;
			}

			case 'lifecycle': {
				const status = (payload.status as string) ?? '';
				appendMessage(
					state,
					{
						role: 'system',
						content: `Run ${status}`,
						metadata: {
							'stardust:type': 'lifecycle',
							'stardust:status': status,
							...(typeof payload.reason === 'string' ? { 'stardust:reason': payload.reason } : {})
						}
					},
					event.sequence
				);
				break;
			}

			case 'memory.candidate': {
				appendMessage(
					state,
					{
						role: 'system',
						content: (payload.content as string) ?? '',
						metadata: {
							'stardust:type': 'memory-candidate'
						}
					},
					event.sequence
				);
				break;
			}
		}
	}

	state.processedCount = events.length;
}

/**
 * Reads an immutable `ConversationHistory` snapshot off the builder state.
 * The conversation is already the immutable structure conversationalist
 * maintains — every fold step replaced it wholesale — so this is a direct
 * read, not a copy.
 */
export function snapshotConversation(state: ConversationBuilderState): ConversationHistory {
	return state.conversation;
}

/**
 * Builds a ConversationHistory from a user message and a stream of events.
 *
 * Tool calls and results are modeled as separate messages with `toolCall` /
 * `toolResult` fields — Cinder's Chat component pairs them automatically via
 * the shared `id`/`callId`.
 *
 * Stardust-specific event types (subagents, approvals, memory candidates,
 * lifecycle markers) are modeled as system messages with metadata so a `row`
 * override can render them.
 *
 * This is a thin wrapper around the incremental builder — "apply all events
 * from empty state" — kept as the pure, provably-correct reference: the
 * incremental path (`createConversationBuilder` + `applyNewStreamEvents`) is
 * tested for deep-equality against this on every chunk boundary.
 */
export function buildConversation(
	sessionId: string,
	userMessage: UserMessage | null,
	events: StreamEvent[]
): ConversationHistory {
	const state = createConversationBuilder(sessionId, userMessage);
	applyNewStreamEvents(state, events);
	return snapshotConversation(state);
}
