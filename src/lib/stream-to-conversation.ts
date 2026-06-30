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
};

/** A user message rendered before the stream (the turn that started the run). */
export type UserMessage = {
	text: string;
};

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

	function addMessage(input: MessageInput): string {
		const id = `msg-${position}`;
		const content = typeof input.content === 'string' ? input.content : [...input.content];
		const message: Message = {
			id,
			role: input.role,
			content,
			position,
			createdAt: now,
			metadata: input.metadata ?? {},
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
			case 'assistant.delta': {
				assistantTextAccumulator += (payload.text as string) ?? '';
				if (assistantMessageId && messages[assistantMessageId]) {
					messages[assistantMessageId] = {
						...messages[assistantMessageId],
						content: assistantTextAccumulator
					};
				} else {
					assistantMessageId = addMessage({
						role: 'assistant',
						content: assistantTextAccumulator
					});
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
					assistantMessageId = addMessage({
						role: 'assistant',
						content: text
					});
				}
				break;
			}

			case 'tool.call': {
				const toolCall: ToolCall = {
					id: payload.id as string,
					name: payload.name as string,
					arguments: (payload.input as JSONValue) ?? {}
				};
				addMessage({
					role: 'tool-call',
					content: `Tool call: ${toolCall.name}`,
					toolCall
				});
				break;
			}

			case 'tool.result': {
				const outcome = (payload.isError as boolean) ? 'error' : 'success';
				const toolResult: ToolResult = {
					callId: payload.callId as string,
					outcome,
					content: (payload.content as JSONValue) ?? ''
				};
				addMessage({
					role: 'tool-result',
					content: `Tool result: ${outcome}`,
					toolResult
				});
				break;
			}

			case 'approval.request': {
				const approvalToolCallId = (payload.approvalId as string) ?? '';
				const toolResult: ToolResult = {
					callId: approvalToolCallId,
					outcome: 'action_required',
					content: `Waiting for approval: ${(payload.toolName as string) ?? 'unknown'}`,
					action: {
						type: 'approval',
						message: `Approve tool call: ${(payload.toolName as string) ?? 'unknown'}`
					}
				};
				addMessage({
					role: 'tool-result',
					content: `Approval required: ${(payload.toolName as string) ?? 'unknown'}`,
					toolResult,
					metadata: {
						'stardust:type': 'approval-request',
						'stardust:toolName': (payload.toolName as string) ?? 'unknown'
					}
				});
				break;
			}

			case 'subagent.start': {
				addMessage({
					role: 'system',
					content: `Subagent started: ${(payload.label as string) ?? ''}`,
					metadata: {
						'stardust:type': 'subagent',
						'stardust:status': 'running',
						'stardust:subagentRunId': (payload.subagentRunId as string) ?? '',
						'stardust:subagentKind': (payload.kind as string) ?? '',
						'stardust:subagentLabel': (payload.label as string) ?? ''
					}
				});
				break;
			}

			case 'subagent.complete': {
				addMessage({
					role: 'system',
					content: `Subagent complete: ${(payload.subagentRunId as string) ?? ''}`,
					metadata: {
						'stardust:type': 'subagent',
						'stardust:status': (payload.status as string) ?? 'complete',
						'stardust:subagentRunId': (payload.subagentRunId as string) ?? ''
					}
				});
				break;
			}

			case 'lifecycle': {
				const status = (payload.status as string) ?? '';
				addMessage({
					role: 'system',
					content: `Run ${status}`,
					metadata: {
						'stardust:type': 'lifecycle',
						'stardust:status': status,
						...(typeof payload.reason === 'string' ? { 'stardust:reason': payload.reason } : {})
					}
				});
				break;
			}

			case 'memory.candidate': {
				addMessage({
					role: 'system',
					content: (payload.content as string) ?? '',
					metadata: {
						'stardust:type': 'memory-candidate'
					}
				});
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
