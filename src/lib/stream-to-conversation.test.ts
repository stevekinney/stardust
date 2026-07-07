import { describe, expect, it } from 'vitest';
import {
	buildConversation,
	findLastUserMessageText,
	mapTranscriptToStreamEvents,
	type StreamEvent,
	type TranscriptEventRow
} from './stream-to-conversation';

function makeEvent(id: number, kind: string, payload: Record<string, unknown>): StreamEvent {
	return { id, kind, payload: JSON.stringify(payload) };
}

describe('buildConversation', () => {
	it('returns an empty conversation when there are no events and no user message', () => {
		const result = buildConversation('session-1', null, []);
		expect(result.ids).toHaveLength(0);
		expect(Object.keys(result.messages)).toHaveLength(0);
		expect(result.id).toBe('session-1');
		expect(result.status).toBe('active');
		expect(result.schemaVersion).toBe(4);
	});

	it('includes a user message when provided', () => {
		const result = buildConversation('s1', { text: 'Hello!' }, []);
		expect(result.ids).toHaveLength(1);
		const msg = result.messages[result.ids[0]];
		expect(msg.role).toBe('user');
		expect(msg.content).toBe('Hello!');
	});

	it('accumulates assistant.delta events into a single assistant message', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'assistant.delta', { text: 'Hello' }),
			makeEvent(2, 'assistant.delta', { text: ', ' }),
			makeEvent(3, 'assistant.delta', { text: 'world!' })
		];
		const result = buildConversation('s1', null, events);
		const assistantMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'assistant');
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].content).toBe('Hello, world!');
	});

	it('handles assistant.message as a full replacement', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'assistant.message', { text: 'The answer is 42.' })
		];
		const result = buildConversation('s1', null, events);
		const assistantMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'assistant');
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].content).toBe('The answer is 42.');
	});

	it('renders a user.message event as a user message', () => {
		const result = buildConversation('s1', null, [
			makeEvent(1, 'user.message', { text: 'What are your capabilities?' })
		]);
		expect(result.ids).toHaveLength(1);
		expect(result.messages[result.ids[0]].role).toBe('user');
		expect(result.messages[result.ids[0]].content).toBe('What are your capabilities?');
	});

	it('renders multiple turns without collapsing assistant replies into one', () => {
		// Regression: a second user turn must reset the assistant accumulator so each
		// turn keeps its own reply instead of the later one overwriting the earlier.
		const events: StreamEvent[] = [
			makeEvent(1, 'user.message', { text: 'Fact about the moon?' }),
			makeEvent(2, 'assistant.message', { text: 'The moon is drifting away.' }),
			makeEvent(3, 'user.message', { text: 'Fact about Mars?' }),
			makeEvent(4, 'assistant.message', { text: 'Mars has the largest volcano.' })
		];
		const result = buildConversation('s1', null, events);
		const roles = result.ids.map((id) => result.messages[id].role);
		expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
		const contents = result.ids.map((id) => result.messages[id].content);
		expect(contents).toEqual([
			'Fact about the moon?',
			'The moon is drifting away.',
			'Fact about Mars?',
			'Mars has the largest volcano.'
		]);
	});

	it('resets streamed deltas at a new user turn', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'user.message', { text: 'First?' }),
			makeEvent(2, 'assistant.delta', { text: 'First answer.' }),
			makeEvent(3, 'user.message', { text: 'Second?' }),
			makeEvent(4, 'assistant.delta', { text: 'Second answer.' })
		];
		const result = buildConversation('s1', null, events);
		const assistants = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'assistant');
		expect(assistants).toHaveLength(2);
		expect(assistants[0].content).toBe('First answer.');
		expect(assistants[1].content).toBe('Second answer.');
	});

	it('renders post-tool assistant text below the tool rows, keeping the pre-tool text', () => {
		// Regression: a tool call must reset the assistant accumulator so the answer
		// after the tool renders as its own message below the tool call/result — not
		// overwriting or folding into the pre-tool narration above them.
		const events: StreamEvent[] = [
			makeEvent(1, 'user.message', { text: 'List files then count them' }),
			makeEvent(2, 'assistant.delta', { text: 'Let me check the workspace.' }),
			makeEvent(3, 'tool.call', { id: 'tc1', name: 'workspace.list', input: {} }),
			makeEvent(4, 'tool.result', { callId: 'tc1', content: 'a.ts\nb.ts\nc.ts' }),
			makeEvent(5, 'assistant.message', { text: 'There are 3 files.' })
		];
		const result = buildConversation('s1', null, events);
		const rows = result.ids.map((id) => ({
			role: result.messages[id].role,
			content: result.messages[id].content
		}));
		expect(rows.map((r) => r.role)).toEqual([
			'user',
			'assistant',
			'tool-call',
			'tool-result',
			'assistant'
		]);
		expect(rows[1].content).toBe('Let me check the workspace.');
		expect(rows[4].content).toBe('There are 3 files.');
	});

	it('creates tool-call messages with the toolCall field', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-001',
				name: 'workspace.readFile',
				input: { path: 'notes.md' }
			})
		];
		const result = buildConversation('s1', null, events);
		const toolCallMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'tool-call');
		expect(toolCallMessages).toHaveLength(1);
		expect(toolCallMessages[0].toolCall).toEqual({
			id: 'tc-001',
			name: 'workspace.readFile',
			arguments: { path: 'notes.md' }
		});
	});

	it('creates tool-result messages with the toolResult field', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-001',
				name: 'workspace.readFile',
				input: { path: 'notes.md' }
			}),
			makeEvent(2, 'tool.result', {
				callId: 'tc-001',
				content: '# Notes\nsome content',
				isError: false
			})
		];
		const result = buildConversation('s1', null, events);
		const toolResultMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'tool-result');
		expect(toolResultMessages).toHaveLength(1);
		expect(toolResultMessages[0].toolResult).toEqual({
			callId: 'tc-001',
			outcome: 'success',
			content: '# Notes\nsome content'
		});
	});

	it('marks errored tool results with outcome error', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.result', {
				callId: 'tc-001',
				content: 'Permission denied',
				isError: true
			})
		];
		const result = buildConversation('s1', null, events);
		const toolResultMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'tool-result');
		expect(toolResultMessages[0].toolResult?.outcome).toBe('error');
	});

	it('creates lifecycle system messages with status metadata', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'lifecycle', { status: 'started' }),
			makeEvent(2, 'lifecycle', { status: 'complete' })
		];
		const result = buildConversation('s1', null, events);
		const systemMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'system');
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[0].metadata['stardust:type']).toBe('lifecycle');
		expect(systemMessages[0].metadata['stardust:status']).toBe('started');
		expect(systemMessages[1].metadata['stardust:status']).toBe('complete');
	});

	it('includes failure reason in lifecycle system messages', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'lifecycle', {
				status: 'failed',
				reason: 'Timeout exceeded'
			})
		];
		const result = buildConversation('s1', null, events);
		const failMsg = result.ids
			.map((id) => result.messages[id])
			.find((m) => m.metadata['stardust:status'] === 'failed');
		expect(failMsg?.metadata['stardust:reason']).toBe('Timeout exceeded');
	});

	it('creates subagent system messages', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'subagent.start', {
				subagentRunId: 'sub-001',
				kind: 'research',
				label: 'Research: climate'
			}),
			makeEvent(2, 'subagent.complete', {
				subagentRunId: 'sub-001',
				status: 'complete'
			})
		];
		const result = buildConversation('s1', null, events);
		const subagentMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.metadata['stardust:type'] === 'subagent');
		expect(subagentMessages).toHaveLength(2);
		expect(subagentMessages[0].metadata['stardust:status']).toBe('running');
		expect(subagentMessages[0].metadata['stardust:subagentLabel']).toBe('Research: climate');
		expect(subagentMessages[1].metadata['stardust:status']).toBe('complete');
	});

	it('creates approval-request messages with action_required outcome', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', {
				approvalId: 'apr-001',
				toolName: 'shell.exec'
			})
		];
		const result = buildConversation('s1', null, events);
		const approvalMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.metadata['stardust:type'] === 'approval-request');
		expect(approvalMessages).toHaveLength(1);
		expect(approvalMessages[0].toolResult?.outcome).toBe('action_required');
		expect(approvalMessages[0].metadata['stardust:toolName']).toBe('shell.exec');
	});

	it('creates memory candidate system messages', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'memory.candidate', { content: 'User prefers dark theme' })
		];
		const result = buildConversation('s1', null, events);
		const memoryMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.metadata['stardust:type'] === 'memory-candidate');
		expect(memoryMessages).toHaveLength(1);
		expect(memoryMessages[0].content).toBe('User prefers dark theme');
	});

	it('preserves message ordering: user, lifecycle, tool, assistant', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'lifecycle', { status: 'started' }),
			makeEvent(2, 'tool.call', { id: 'tc-1', name: 'readFile', input: {} }),
			makeEvent(3, 'tool.result', { callId: 'tc-1', content: 'ok', isError: false }),
			makeEvent(4, 'assistant.message', { text: 'Done!' }),
			makeEvent(5, 'lifecycle', { status: 'complete' })
		];
		const result = buildConversation('s1', { text: 'Do it' }, events);
		const roles = result.ids.map((id) => result.messages[id].role);
		expect(roles).toEqual(['user', 'system', 'tool-call', 'tool-result', 'assistant', 'system']);
	});

	it('skips events with malformed JSON payloads', () => {
		const events: StreamEvent[] = [
			{ id: 1, kind: 'assistant.delta', payload: 'not json' },
			makeEvent(2, 'assistant.message', { text: 'Valid' })
		];
		const result = buildConversation('s1', null, events);
		const assistantMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'assistant');
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].content).toBe('Valid');
	});

	it('positions messages sequentially starting from 0', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'assistant.delta', { text: 'Hi' }),
			makeEvent(2, 'lifecycle', { status: 'complete' })
		];
		const result = buildConversation('s1', { text: 'Hello' }, events);
		const positions = result.ids.map((id) => result.messages[id].position);
		expect(positions).toEqual([0, 1, 2]);
	});
});

/**
 * Cinder's `tool-call-group` derives a tool call's UI state entirely from
 * whether a paired `tool-result` message exists yet, and from that result's
 * `outcome` once it arrives (see `tool-call-group.svelte`: no result →
 * "Pending"; `outcome: 'success'` → "Complete"; `outcome: 'error'` →
 * "Failed"; `outcome: 'action_required'` → "Action required"). Stardust's
 * transcript event model only emits `tool.call` and `tool.result` — there is
 * no separate "queued" vs. "running" server event — so both of those labels
 * collapse into the same "no result yet" representation here. These tests
 * cover each of the four states this mapping is responsible for producing.
 */
describe('buildConversation — tool-call states', () => {
	it('queued/pending: a tool call with no result yet has no toolResult field', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', { id: 'tc-pending', name: 'shell.exec', input: { command: 'ls' } })
		];
		const result = buildConversation('s1', null, events);
		const toolCallMessage = result.ids
			.map((id) => result.messages[id])
			.find((m) => m.role === 'tool-call');
		expect(toolCallMessage?.toolCall).toEqual({
			id: 'tc-pending',
			name: 'shell.exec',
			arguments: { command: 'ls' }
		});
		expect(toolCallMessage?.toolResult).toBeUndefined();
	});

	it('running: a pending tool call survives intervening stream events unresolved', () => {
		// The call stays paired to no result across further deltas/tool calls that
		// arrive while it's still executing — it must not be prematurely marked
		// resolved or clobbered by unrelated events landing in between.
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', { id: 'tc-running', name: 'shell.exec', input: { command: 'ls' } }),
			makeEvent(2, 'assistant.delta', { text: 'Still working on it…' }),
			makeEvent(3, 'tool.call', { id: 'tc-other', name: 'workspace.list', input: {} }),
			makeEvent(4, 'tool.result', { callId: 'tc-other', content: 'a.ts', isError: false })
		];
		const result = buildConversation('s1', null, events);
		const toolCallMessages = result.ids
			.map((id) => result.messages[id])
			.filter((m) => m.role === 'tool-call');
		const running = toolCallMessages.find((m) => m.toolCall?.id === 'tc-running');
		const other = toolCallMessages.find((m) => m.toolCall?.id === 'tc-other');
		expect(running?.toolResult).toBeUndefined();
		expect(other?.toolResult).toBeUndefined();
	});

	it('succeeded: a tool result with isError false resolves the call to outcome success', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-success',
				name: 'workspace.readFile',
				input: { path: 'notes.md' }
			}),
			makeEvent(2, 'tool.result', {
				callId: 'tc-success',
				content: '# Notes\nall good',
				isError: false
			})
		];
		const result = buildConversation('s1', null, events);
		const toolResultMessage = result.ids
			.map((id) => result.messages[id])
			.find((m) => m.role === 'tool-result');
		expect(toolResultMessage?.toolResult).toEqual({
			callId: 'tc-success',
			outcome: 'success',
			content: '# Notes\nall good'
		});
	});

	it('failed: a tool result with isError true resolves to outcome error with detail visible', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-failed',
				name: 'shell.exec',
				input: { command: 'rm -rf' }
			}),
			makeEvent(2, 'tool.result', {
				callId: 'tc-failed',
				content: 'Permission denied: cannot execute command',
				isError: true
			})
		];
		const result = buildConversation('s1', null, events);
		const toolResultMessage = result.ids
			.map((id) => result.messages[id])
			.find((m) => m.role === 'tool-result');
		expect(toolResultMessage?.toolResult?.outcome).toBe('error');
		// The error detail is carried through in `content` so it renders even
		// though Stardust doesn't populate Cinder's optional structured `error`
		// field — `tool-call-group.svelte` falls back to stringifying `content`
		// when `error.message` is absent.
		expect(toolResultMessage?.toolResult?.content).toBe(
			'Permission denied: cannot execute command'
		);
	});
});

/**
 * Simulates the load path the session page runs on mount
 * (`+page.svelte`'s `loadTranscript`, now backed by `mapTranscriptToStreamEvents`
 * / `findLastUserMessageText`) against durable transcript rows shaped exactly
 * like `GET /api/sessions/{sessionKey}/transcript` returns them.
 */
describe('mapTranscriptToStreamEvents — refresh rehydration', () => {
	function makeRow(
		sequence: number,
		kind: string,
		payload: Record<string, unknown>
	): TranscriptEventRow {
		return { id: `evt-${sequence}`, kind, payload: JSON.stringify(payload), sequence };
	}

	it('recovers an in-flight tool call as pending, not failed or lost, after a refresh', () => {
		// The workflow is mid-tool-call: the `tool_call` row is durable, but the
		// matching `tool_result` row hasn't been written yet.
		const rows: TranscriptEventRow[] = [
			makeRow(0, 'user_message', { text: 'List the files' }),
			makeRow(1, 'tool_call', { calls: [{ id: 'tc-live', name: 'workspace.list', input: {} }] })
		];

		const streamEvents = mapTranscriptToStreamEvents(rows);
		const conversation = buildConversation('s1', null, streamEvents);
		const toolCallMessage = conversation.ids
			.map((id) => conversation.messages[id])
			.find((m) => m.role === 'tool-call');

		expect(toolCallMessage?.toolCall?.id).toBe('tc-live');
		expect(toolCallMessage?.toolResult).toBeUndefined();

		const toolResultMessages = conversation.ids
			.map((id) => conversation.messages[id])
			.filter((m) => m.role === 'tool-result');
		expect(toolResultMessages).toHaveLength(0);
	});

	it('reconciles to success once the result row lands in a later transcript fetch', () => {
		// The next poll (or the next page load) sees the completed transcript —
		// the same `callId` now has a matching `tool_result` row.
		const rows: TranscriptEventRow[] = [
			makeRow(0, 'user_message', { text: 'List the files' }),
			makeRow(1, 'tool_call', { calls: [{ id: 'tc-live', name: 'workspace.list', input: {} }] }),
			makeRow(2, 'tool_result', { callId: 'tc-live', content: 'a.ts\nb.ts', isError: false })
		];

		const streamEvents = mapTranscriptToStreamEvents(rows);
		const conversation = buildConversation('s1', null, streamEvents);
		const toolResultMessage = conversation.ids
			.map((id) => conversation.messages[id])
			.find((m) => m.role === 'tool-result');

		expect(toolResultMessage?.toolResult).toEqual({
			callId: 'tc-live',
			outcome: 'success',
			content: 'a.ts\nb.ts'
		});
	});

	it('fans a batched tool_call row into one StreamEvent per call, sharing its sequence', () => {
		const rows: TranscriptEventRow[] = [
			makeRow(3, 'tool_call', {
				calls: [
					{ id: 'tc-a', name: 'workspace.list', input: {} },
					{ id: 'tc-b', name: 'workspace.readFile', input: { path: 'a.ts' } }
				]
			})
		];

		const streamEvents = mapTranscriptToStreamEvents(rows);
		expect(streamEvents).toHaveLength(2);
		expect(streamEvents.every((event) => event.kind === 'tool.call')).toBe(true);
		expect(streamEvents.every((event) => event.sequence === 3)).toBe(true);
	});

	it('finds the most recent user message text across transcript rows', () => {
		const rows: TranscriptEventRow[] = [
			makeRow(0, 'user_message', { text: 'First question' }),
			makeRow(1, 'assistant_message', { text: 'First answer' }),
			makeRow(2, 'user_message', { text: 'Second question' })
		];
		expect(findLastUserMessageText(rows)).toBe('Second question');
	});

	it('returns null when there is no user message row', () => {
		expect(findLastUserMessageText([])).toBeNull();
	});
});
