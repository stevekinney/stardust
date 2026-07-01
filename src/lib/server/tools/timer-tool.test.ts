import { describe, expect, it } from 'vitest';
import { TASK_QUEUE_ORCHESTRATOR, TASK_QUEUE_TOOLS } from '@src/lib/types';
import {
	defineSessionMessagingTools,
	defineTimerTools,
	sessionSendMessageInput,
	timerWaitInput,
	timerWaitStubContent
} from './timer-tool';

describe('timerWaitInput', () => {
	it('accepts a positive integer durationMs with no reason', () => {
		const parsed = timerWaitInput.safeParse({ durationMs: 60_000 });
		expect(parsed.success).toBe(true);
	});

	it('accepts a durationMs with an optional reason', () => {
		const parsed = timerWaitInput.safeParse({ durationMs: 60_000, reason: 'check deploy status' });
		expect(parsed.success).toBe(true);
	});

	it('accepts the maximum 30-day duration', () => {
		const parsed = timerWaitInput.safeParse({ durationMs: 30 * 24 * 60 * 60 * 1000 });
		expect(parsed.success).toBe(true);
	});

	it('rejects a duration beyond 30 days', () => {
		const parsed = timerWaitInput.safeParse({ durationMs: 30 * 24 * 60 * 60 * 1000 + 1 });
		expect(parsed.success).toBe(false);
	});

	it('rejects a zero or negative duration', () => {
		expect(timerWaitInput.safeParse({ durationMs: 0 }).success).toBe(false);
		expect(timerWaitInput.safeParse({ durationMs: -1 }).success).toBe(false);
	});

	it('rejects a non-integer duration', () => {
		expect(timerWaitInput.safeParse({ durationMs: 100.5 }).success).toBe(false);
	});

	it('rejects an empty-string reason', () => {
		expect(timerWaitInput.safeParse({ durationMs: 1_000, reason: '' }).success).toBe(false);
	});

	it('rejects missing durationMs', () => {
		expect(timerWaitInput.safeParse({}).success).toBe(false);
	});
});

describe('defineTimerTools', () => {
	it('registers exactly one tool named timer.wait', () => {
		const tools = defineTimerTools();
		expect(tools.map((tool) => tool.name)).toEqual(['timer.wait']);
	});

	it('never requires approval and runs on the orchestrator task queue', () => {
		const [timerWaitTool] = defineTimerTools();
		expect(timerWaitTool?.metadata.requiresApproval).toBe(false);
		expect(timerWaitTool?.metadata.risk).toBe('low');
		expect(timerWaitTool?.metadata.taskQueue).toBe(TASK_QUEUE_ORCHESTRATOR);
	});

	it('exposes the zod schema on the registered tool for the policy engine', () => {
		const [timerWaitTool] = defineTimerTools();
		expect(timerWaitTool?.schema).toBe(timerWaitInput);
	});
});

describe('timerWaitStubContent', () => {
	it('carries the wait arguments and explains the workflow-interception message', () => {
		const content = timerWaitStubContent({ durationMs: 5_000, reason: 'demo' });
		expect(content).toEqual({
			durationMs: 5_000,
			reason: 'demo',
			message: 'timer.wait is executed by the orchestrator workflow, not inside a tool activity.'
		});
	});

	it('omits reason when not provided', () => {
		const content = timerWaitStubContent({ durationMs: 5_000 });
		expect(content).not.toHaveProperty('reason');
	});
});

describe('sessionSendMessageInput', () => {
	it('accepts a non-empty sessionKey and message', () => {
		const parsed = sessionSendMessageInput.safeParse({
			sessionKey: 'target-session',
			message: 'hello from another session'
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects an empty sessionKey', () => {
		expect(sessionSendMessageInput.safeParse({ sessionKey: '', message: 'hi' }).success).toBe(
			false
		);
	});

	it('rejects an empty message', () => {
		expect(
			sessionSendMessageInput.safeParse({ sessionKey: 'target-session', message: '' }).success
		).toBe(false);
	});
});

describe('defineSessionMessagingTools', () => {
	it('registers exactly one tool named session.sendMessage', () => {
		const tools = defineSessionMessagingTools();
		expect(tools.map((tool) => tool.name)).toEqual(['session.sendMessage']);
	});

	it('requires approval and runs on the tools task queue with key-required idempotency', () => {
		const [sendMessageTool] = defineSessionMessagingTools();
		expect(sendMessageTool?.metadata.requiresApproval).toBe(true);
		expect(sendMessageTool?.metadata.risk).toBe('medium');
		expect(sendMessageTool?.metadata.taskQueue).toBe(TASK_QUEUE_TOOLS);
		expect(sendMessageTool?.metadata.idempotencyBehavior).toBe('key-required');
	});
});
