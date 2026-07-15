import { describe, expect, it, vi } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import type { TranscriptEventRow } from '$lib/stream-to-conversation';
import {
	SessionReconnection,
	transcriptHasTerminalEvent,
	transcriptHasUnsettledRun,
	type SessionReconnectionSnapshot,
	type SessionReconnectionState
} from './session-reconnection';

function projection(runId: string, status: string): RunInspectorProjection {
	return { run: { id: runId, status } } as RunInspectorProjection;
}

function lifecycle(runId: string, status: string, sequence = 1): TranscriptEventRow {
	return {
		id: `${runId}:${status}`,
		runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status, recoverySafe: true }),
		sequence
	};
}

function subagentLifecycle(runId: string, status: string, sequence = 1): TranscriptEventRow {
	return {
		id: `${runId}:subagent:${status}`,
		runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ type: 'subagent.complete', status }),
		sequence
	};
}

function snapshot(
	status: string | null,
	options: { runId?: string; transcript?: TranscriptEventRow[] } = {}
): SessionReconnectionSnapshot {
	return {
		transcript: options.transcript ?? [],
		inspector: status === null ? null : projection(options.runId ?? 'run-1', status),
		runCount: status === null ? 0 : 1,
		pendingApproval: null
	};
}

function harness(readSnapshot: (signal: AbortSignal) => Promise<SessionReconnectionSnapshot>) {
	const callbacks: Array<() => void> = [];
	const states: SessionReconnectionState[] = [];
	const applied: SessionReconnectionSnapshot[] = [];
	const reconnection = new SessionReconnection({
		readSnapshot,
		applySnapshot: (value) => applied.push(value),
		setState: (state) => states.push(state),
		schedule: (callback) => {
			callbacks.push(callback);
			return callbacks.length as unknown as ReturnType<typeof setTimeout>;
		},
		cancelSchedule: vi.fn(),
		maximumUnobservableAttempts: 3,
		maximumHandoffAttempts: 2,
		maximumSettlementAttempts: 3
	});

	async function settle(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}

	async function advance(): Promise<void> {
		const callback = callbacks.shift();
		expect(callback).toBeDefined();
		callback?.();
		await settle();
	}

	return { reconnection, states, applied, callbacks, settle, advance };
}

describe('session reconnection state machine', () => {
	it('keeps observing a healthy active run without a duration cap', async () => {
		const testHarness = harness(vi.fn().mockResolvedValue(snapshot('running')));
		testHarness.reconnection.start();
		await testHarness.settle();

		for (let index = 0; index < 20; index += 1) await testHarness.advance();

		expect(testHarness.states.at(-1)).toEqual({ kind: 'observing', runId: 'run-1' });
		expect(testHarness.applied).toHaveLength(21);
	});

	it('refreshes canonical state while a run waits for approval', async () => {
		const testHarness = harness(vi.fn().mockResolvedValue(snapshot('waiting_approval')));
		testHarness.reconnection.start();
		await testHarness.settle();

		expect(testHarness.states.at(-1)).toEqual({
			kind: 'awaiting-approval',
			runId: 'run-1'
		});
		expect(testHarness.callbacks).toHaveLength(1);
	});

	it('waits for the canonical terminal row before entering handoff', async () => {
		const readSnapshot = vi
			.fn()
			.mockResolvedValueOnce(snapshot('complete'))
			.mockResolvedValue(snapshot('complete', { transcript: [lifecycle('run-1', 'complete')] }));
		const testHarness = harness(readSnapshot);
		testHarness.reconnection.start();
		await testHarness.settle();

		expect(testHarness.states.at(-1)).toEqual({
			kind: 'settling',
			runId: 'run-1',
			status: 'complete'
		});
		await testHarness.advance();
		expect(testHarness.states.at(-1)).toEqual({ kind: 'handoff', runId: 'run-1', attempt: 1 });
	});

	it('bounds settlement when the canonical terminal row never appears', async () => {
		const testHarness = harness(vi.fn().mockResolvedValue(snapshot('complete')));
		testHarness.reconnection.start();
		await testHarness.settle();
		await testHarness.advance();
		await testHarness.advance();

		expect(testHarness.states.at(-1)).toEqual({
			kind: 'failed-unobservable',
			message:
				'This run finished, but its canonical terminal event could not be observed. Reload to try reconnecting again.'
		});
		expect(testHarness.callbacks).toHaveLength(0);
	});

	it('follows a queued run handoff and observes the replacement run', async () => {
		const terminal = snapshot('complete', { transcript: [lifecycle('run-1', 'complete')] });
		const readSnapshot = vi
			.fn()
			.mockResolvedValueOnce(terminal)
			.mockResolvedValueOnce(snapshot('running', { runId: 'run-2' }))
			.mockResolvedValue(snapshot('running', { runId: 'run-2' }));
		const testHarness = harness(readSnapshot);
		testHarness.reconnection.start();
		await testHarness.settle();
		await testHarness.advance();

		expect(testHarness.states.at(-1)).toEqual({ kind: 'handoff', runId: 'run-2', attempt: 0 });
		await testHarness.advance();
		expect(testHarness.states.at(-1)).toEqual({ kind: 'observing', runId: 'run-2' });
	});

	it('settles after a bounded handoff window when no replacement appears', async () => {
		const terminal = snapshot('complete', { transcript: [lifecycle('run-1', 'complete')] });
		const testHarness = harness(vi.fn().mockResolvedValue(terminal));
		testHarness.reconnection.start();
		await testHarness.settle();
		await testHarness.advance();
		await testHarness.advance();

		expect(testHarness.states.at(-1)).toEqual({ kind: 'dormant' });
		expect(testHarness.callbacks).toHaveLength(0);
	});

	it('surfaces repeated missing run rows as unobservable', async () => {
		const testHarness = harness(vi.fn().mockResolvedValue(snapshot(null)));
		testHarness.reconnection.start();
		await testHarness.settle();
		await testHarness.advance();
		await testHarness.advance();

		expect(testHarness.states.at(-1)?.kind).toBe('failed-unobservable');
	});

	it('bounds repeated rejected observations', async () => {
		const testHarness = harness(vi.fn().mockRejectedValue(new Error('offline')));
		testHarness.reconnection.start();
		await testHarness.settle();
		await testHarness.advance();
		await testHarness.advance();

		expect(testHarness.states.at(-1)?.kind).toBe('failed-unobservable');
	});

	it('aborts and ignores an in-flight snapshot after cleanup', async () => {
		let resolveSnapshot: ((value: SessionReconnectionSnapshot) => void) | undefined;
		const readSnapshot = vi.fn(
			(signal: AbortSignal) =>
				new Promise<SessionReconnectionSnapshot>((resolve) => {
					resolveSnapshot = resolve;
					expect(signal.aborted).toBe(false);
				})
		);
		const testHarness = harness(readSnapshot);
		testHarness.reconnection.start();
		testHarness.reconnection.stop();
		resolveSnapshot?.(snapshot('running'));
		await testHarness.settle();

		expect(testHarness.applied).toHaveLength(0);
		expect(testHarness.callbacks).toHaveLength(0);
	});
});

describe('session reconnection transcript decisions', () => {
	it('matches terminal lifecycle rows to their run', () => {
		const transcript = [lifecycle('run-1', 'complete')];
		expect(transcriptHasTerminalEvent(transcript, 'run-1', 'complete')).toBe(true);
		expect(transcriptHasTerminalEvent(transcript, 'run-2', 'complete')).toBe(false);
	});

	it('does not treat a subagent completion as the parent terminal lifecycle', () => {
		const transcript = [
			lifecycle('run-1', 'started', 1),
			subagentLifecycle('run-1', 'complete', 2)
		];
		expect(transcriptHasTerminalEvent(transcript, 'run-1', 'complete')).toBe(false);
		expect(transcriptHasUnsettledRun(transcript)).toBe(true);
	});

	it('detects an unsettled run without treating an earlier completed turn as active', () => {
		expect(
			transcriptHasUnsettledRun([
				lifecycle('run-1', 'complete', 2),
				lifecycle('run-2', 'started', 1)
			])
		).toBe(true);
		expect(transcriptHasUnsettledRun([lifecycle('run-1', 'complete')])).toBe(false);
	});
});
