import type { RunInspectorProjection } from '$lib/server/observability/projection';
import type { TranscriptEventRow } from '$lib/stream-to-conversation';
import type { PendingApprovalEntry } from '$lib/types';

export type SessionReconnectionState =
	| { kind: 'dormant' }
	| { kind: 'discovering'; attempt: number }
	| { kind: 'observing'; runId: string }
	| { kind: 'awaiting-approval'; runId: string }
	| { kind: 'settling'; runId: string; status: string }
	| { kind: 'handoff'; runId: string; attempt: number }
	| { kind: 'failed-unobservable'; message: string };

export type SessionReconnectionSnapshot = {
	transcript: TranscriptEventRow[];
	inspector: RunInspectorProjection | null;
	runCount: number;
	pendingApproval: PendingApprovalEntry | null;
};

type ScheduledHandle = ReturnType<typeof setTimeout>;

export type SessionReconnectionDependencies = {
	readSnapshot: (signal: AbortSignal) => Promise<SessionReconnectionSnapshot>;
	applySnapshot: (snapshot: SessionReconnectionSnapshot) => void;
	setState: (state: SessionReconnectionState) => void;
	schedule?: (callback: () => void, delay: number) => ScheduledHandle;
	cancelSchedule?: (handle: ScheduledHandle) => void;
	intervalMilliseconds?: number;
	maximumUnobservableAttempts?: number;
	maximumHandoffAttempts?: number;
	maximumSettlementAttempts?: number;
};

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled', 'recovered']);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
	return status != null && TERMINAL_STATUSES.has(status);
}

export function transcriptHasTerminalEvent(
	transcript: TranscriptEventRow[],
	runId: string,
	status: string
): boolean {
	return transcript.some((event) => {
		return event.runId === runId && parentLifecycleStatus(event) === status;
	});
}

function parentLifecycleStatus(event: TranscriptEventRow): string | null {
	if (event.kind !== 'lifecycle') return null;
	try {
		const payload = JSON.parse(event.payload) as {
			type?: unknown;
			status?: unknown;
			recoverySafe?: unknown;
		};
		if (payload.type !== undefined || payload.recoverySafe !== true) return null;
		return typeof payload.status === 'string' ? payload.status : null;
	} catch {
		return null;
	}
}

export function transcriptHasUnsettledRun(transcript: TranscriptEventRow[]): boolean {
	const latestStatusByRun = new Map<string, string>();
	for (const event of transcript) {
		const status = parentLifecycleStatus(event);
		if (status !== null) latestStatusByRun.set(event.runId, status);
	}
	return [...latestStatusByRun.values()].some((status) => !isTerminalRunStatus(status));
}

/**
 * Owns reload catch-up as one cancellable, non-overlapping state machine.
 * Successful observations never expire merely because a run is long-lived;
 * only repeated inability to observe any canonical state is bounded.
 */
export class SessionReconnection {
	private readonly schedule: NonNullable<SessionReconnectionDependencies['schedule']>;
	private readonly cancelSchedule: NonNullable<SessionReconnectionDependencies['cancelSchedule']>;
	private readonly intervalMilliseconds: number;
	private readonly maximumUnobservableAttempts: number;
	private readonly maximumHandoffAttempts: number;
	private readonly maximumSettlementAttempts: number;
	private generation = 0;
	private controller: AbortController | null = null;
	private scheduled: ScheduledHandle | null = null;
	private unobservableAttempts = 0;
	private missingRunAttempts = 0;
	private observedRunId: string | null = null;
	private handoffAttempts = 0;
	private settlementAttempts = 0;

	constructor(private readonly dependencies: SessionReconnectionDependencies) {
		this.schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay));
		this.cancelSchedule = dependencies.cancelSchedule ?? ((handle) => clearTimeout(handle));
		this.intervalMilliseconds = dependencies.intervalMilliseconds ?? 1_000;
		this.maximumUnobservableAttempts = dependencies.maximumUnobservableAttempts ?? 5;
		this.maximumHandoffAttempts = dependencies.maximumHandoffAttempts ?? 5;
		this.maximumSettlementAttempts = dependencies.maximumSettlementAttempts ?? 30;
	}

	start(): void {
		this.stop();
		this.unobservableAttempts = 0;
		this.missingRunAttempts = 0;
		this.observedRunId = null;
		this.handoffAttempts = 0;
		this.settlementAttempts = 0;
		this.dependencies.setState({ kind: 'discovering', attempt: 1 });
		void this.poll(this.generation);
	}

	stop(): void {
		this.generation += 1;
		this.controller?.abort();
		this.controller = null;
		if (this.scheduled !== null) this.cancelSchedule(this.scheduled);
		this.scheduled = null;
	}

	private isCurrent(generation: number): boolean {
		return generation === this.generation;
	}

	private scheduleNext(generation: number): void {
		if (!this.isCurrent(generation)) return;
		this.scheduled = this.schedule(() => {
			this.scheduled = null;
			void this.poll(generation);
		}, this.intervalMilliseconds);
	}

	private failUnobservable(): void {
		const message =
			'This run can no longer be observed from canonical state. Reload to try reconnecting again.';
		this.dependencies.setState({ kind: 'failed-unobservable', message });
		this.stop();
	}

	private failSettlement(): void {
		this.dependencies.setState({
			kind: 'failed-unobservable',
			message:
				'This run finished, but its canonical terminal event could not be observed. Reload to try reconnecting again.'
		});
		this.stop();
	}

	private async poll(generation: number): Promise<void> {
		if (!this.isCurrent(generation)) return;
		const controller = new AbortController();
		this.controller = controller;

		let snapshot: SessionReconnectionSnapshot;
		try {
			snapshot = await this.dependencies.readSnapshot(controller.signal);
		} catch {
			if (!this.isCurrent(generation) || controller.signal.aborted) return;
			this.unobservableAttempts += 1;
			if (this.unobservableAttempts >= this.maximumUnobservableAttempts) {
				this.failUnobservable();
				return;
			}
			this.dependencies.setState({ kind: 'discovering', attempt: this.unobservableAttempts + 1 });
			this.scheduleNext(generation);
			return;
		}

		if (!this.isCurrent(generation)) return;
		this.controller = null;
		this.unobservableAttempts = 0;
		this.dependencies.applySnapshot(snapshot);

		const projection = snapshot.inspector;
		if (!projection) {
			this.missingRunAttempts += 1;
			if (this.missingRunAttempts >= this.maximumUnobservableAttempts) {
				this.failUnobservable();
				return;
			}
			this.dependencies.setState({ kind: 'discovering', attempt: this.missingRunAttempts + 1 });
			this.scheduleNext(generation);
			return;
		}
		this.missingRunAttempts = 0;

		const { id: runId, status } = projection.run;
		if (this.observedRunId && runId !== this.observedRunId) {
			this.observedRunId = runId;
			this.handoffAttempts = 0;
			this.settlementAttempts = 0;
			this.dependencies.setState({ kind: 'handoff', runId, attempt: 0 });
			this.scheduleNext(generation);
			return;
		}
		this.observedRunId = runId;

		if (isTerminalRunStatus(status)) {
			if (!transcriptHasTerminalEvent(snapshot.transcript, runId, status)) {
				this.settlementAttempts += 1;
				if (this.settlementAttempts >= this.maximumSettlementAttempts) {
					this.failSettlement();
					return;
				}
				this.dependencies.setState({ kind: 'settling', runId, status });
				this.scheduleNext(generation);
				return;
			}
			this.settlementAttempts = 0;

			if (this.handoffAttempts < this.maximumHandoffAttempts) {
				this.handoffAttempts += 1;
				this.dependencies.setState({ kind: 'handoff', runId, attempt: this.handoffAttempts });
				this.scheduleNext(generation);
				return;
			}

			this.dependencies.setState({ kind: 'dormant' });
			this.stop();
			return;
		}

		this.handoffAttempts = 0;
		this.settlementAttempts = 0;
		this.dependencies.setState(
			status === 'waiting_approval'
				? { kind: 'awaiting-approval', runId }
				: { kind: 'observing', runId }
		);
		this.scheduleNext(generation);
	}
}
