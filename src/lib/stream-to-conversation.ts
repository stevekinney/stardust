/**
 * Transforms Stardust's SSE StreamEvent[] into Cinder's ConversationHistory.
 *
 * This is the adapter between Stardust's real-time event model and the
 * immutable conversation snapshot that Cinder's Chat component renders.
 */

import type {
	ConversationHistory,
	JSONValue,
	Message,
	MessageInput,
	ToolCall,
	ToolResult
} from '@lostgradient/cinder/chat';

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
};

/** A raw row as returned by `GET /api/sessions/{sessionKey}/transcript`. */
export type TranscriptEventRow = {
	id: string;
	kind: string;
	payload: string;
	sequence: number;
};

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
 * Builds a ConversationHistory from a user message and a stream of events.
 *
 * Tool calls and results are modeled as separate messages with `toolCall` /
 * `toolResult` fields — Cinder's Chat component pairs them automatically via
 * the shared `id`/`callId`.
 *
 * Stardust-specific event types (subagents, approvals, memory candidates,
 * lifecycle markers) are modeled as system messages with metadata so a `row`
 * override can render them.
 */
export function buildConversation(
	sessionId: string,
	userMessage: UserMessage | null,
	events: StreamEvent[]
): ConversationHistory {
	const now = new Date().toISOString();
	const ids: string[] = [];
	const messages: Record<string, Message> = {};
	let position = 0;

	function addMessage(input: MessageInput, sequence?: number): string {
		const id = `msg-${position}`;
		const content = typeof input.content === 'string' ? input.content : [...input.content];
		const message: Message = {
			id,
			role: input.role,
			content,
			position,
			createdAt: now,
			metadata: {
				...(input.metadata ?? {}),
				...(sequence !== undefined ? { 'stardust:sequence': sequence } : {})
			},
			hidden: input.hidden ?? false,
			...(input.toolCall !== undefined ? { toolCall: input.toolCall } : {}),
			...(input.toolResult !== undefined ? { toolResult: input.toolResult } : {})
		};
		ids.push(id);
		messages[id] = message;
		position++;
		return id;
	}

	if (userMessage) {
		addMessage({ role: 'user', content: userMessage.text });
	}

	let assistantTextAccumulator = '';
	let assistantMessageId: string | null = null;

	for (const event of events) {
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
				assistantMessageId = null;
				assistantTextAccumulator = '';
				addMessage({ role: 'user', content: (payload.text as string) ?? '' }, event.sequence);
				break;
			}

			case 'assistant.delta': {
				assistantTextAccumulator += (payload.text as string) ?? '';
				if (assistantMessageId && messages[assistantMessageId]) {
					messages[assistantMessageId] = {
						...messages[assistantMessageId],
						content: assistantTextAccumulator
					};
				} else {
					assistantMessageId = addMessage(
						{ role: 'assistant', content: assistantTextAccumulator },
						event.sequence
					);
				}
				break;
			}

			case 'assistant.message': {
				const text = (payload.text as string) ?? '';
				if (assistantMessageId && messages[assistantMessageId]) {
					assistantTextAccumulator = text;
					messages[assistantMessageId] = {
						...messages[assistantMessageId],
						content: text
					};
				} else {
					assistantTextAccumulator = text;
					assistantMessageId = addMessage({ role: 'assistant', content: text }, event.sequence);
				}
				break;
			}

			case 'tool.call': {
				// A tool call breaks the assistant's turn: any assistant text that
				// follows the tool result is a distinct message that must render *below*
				// the tool call/result rows, not fold back into the pre-tool bubble
				// above them. Reset the accumulator so the post-tool reply starts fresh.
				assistantMessageId = null;
				assistantTextAccumulator = '';
				const toolCall: ToolCall = {
					id: payload.id as string,
					name: payload.name as string,
					arguments: (payload.input as JSONValue) ?? {}
				};
				addMessage(
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
				addMessage(
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
				addMessage(
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
				for (const id of ids) {
					const candidate = messages[id];
					if (
						candidate.metadata['stardust:type'] === 'approval-request' &&
						candidate.metadata['stardust:approvalId'] === approvalId
					) {
						messages[id] = {
							...candidate,
							metadata: { ...candidate.metadata, 'stardust:resolution': action }
						};
					}
				}
				break;
			}

			case 'subagent.start': {
				addMessage(
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
				addMessage(
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
				addMessage(
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
				addMessage(
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

	return {
		schemaVersion: 4,
		id: sessionId,
		title: undefined,
		status: 'active',
		metadata: {},
		ids,
		messages,
		createdAt: now,
		updatedAt: now
	};
}
