import { describe, expect, it } from 'vitest';
import { buildConversation, type StreamEvent } from './stream-to-conversation';

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
