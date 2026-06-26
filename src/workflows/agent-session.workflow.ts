import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalCardState,
	InterruptRunInput,
	InterruptRunResult,
	SessionMemorySnapshot,
	SessionSandboxSnapshot,
	SessionState,
	SubmitSteeringInput,
	SubmitSteeringResult,
	SubmitTurnInput,
	SubmitTurnResult
} from '@src/lib/types';
import {
	CancellationScope,
	allHandlersFinished,
	condition,
	continueAsNew,
	executeChild,
	getExternalWorkflowHandle,
	isCancellation,
	setHandler,
	workflowInfo
} from '@temporalio/workflow';
import { steeringSignal } from './approval-contracts';
import { agentRunWorkflow } from './agent-run.workflow';
import {
	cancelRunSignal,
	getActiveRunQuery,
	getMemorySnapshotQuery,
	getPendingApprovalsQuery,
	getSandboxSnapshotQuery,
	getSessionStateQuery,
	interruptRunUpdate,
	streamDisconnectedSignal,
	submitSteeringUpdate,
	submitTurnUpdate
} from './session-contracts';

// ── Constants ──────────────────────────────────────────────────────────────────

/** 30-day TTL: sessions idle longer than this are considered complete. */
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default number of history events before triggering Continue-As-New.
 * CAN is checked between runs (when the queue is empty) and never mid-run.
 */
const DEFAULT_CAN_HISTORY_THRESHOLD = 5_000;

/** How long to wait for in-flight update handlers to finish before CAN or exit. */
const HANDLER_FINISH_TIMEOUT_MS = 60_000;

// ── Types ──────────────────────────────────────────────────────────────────────

type QueuedTurn = { runId: string; message: string };

/**
 * Input for AgentSessionWorkflow.
 *
 * `completedRunCount`, `submittedTurnCount`, `memoryRefs`, and
 * `canHistoryThreshold` are carried across Continue-As-New boundaries to
 * preserve session continuity. External callers only need to supply
 * `sessionKey`.
 */
export type AgentSessionInput = {
	sessionKey: string;
	/** Carried across Continue-As-New: total runs completed so far. */
	completedRunCount?: number;
	/** Carried across Continue-As-New: total turns submitted so far. */
	submittedTurnCount?: number;
	/** Carried across Continue-As-New: accumulated memory candidate refs. */
	memoryRefs?: string[];
	/**
	 * Override the CAN history-length threshold. Defaults to 5000.
	 * Set low in tests to exercise CAN without generating thousands of events.
	 */
	canHistoryThreshold?: number;
};

// ── Workflow ───────────────────────────────────────────────────────────────────

/**
 * AgentSessionWorkflow — durable session actor.
 *
 * Serialises turns: one AgentRunWorkflow runs at a time; additional turns are
 * queued. Handles steering, interrupt, and cancel by routing to the active run.
 * Tracks memory refs from completed runs. Performs Continue-As-New only between
 * runs to avoid Temporal event-history overflow.
 */
export async function agentSessionWorkflow(input: AgentSessionInput): Promise<void> {
	const { sessionKey } = input;
	const canThreshold = input.canHistoryThreshold ?? DEFAULT_CAN_HISTORY_THRESHOLD;

	// ── Mutable state ────────────────────────────────────────────────────────

	const queue: QueuedTurn[] = [];
	let activeRunId: string | null = null;
	/** CancellationScope for the currently executing child run; undefined when idle. */
	let activeRunScope: CancellationScope | undefined;
	let completedRunCount = input.completedRunCount ?? 0;
	let submittedTurnCount = input.submittedTurnCount ?? 0;
	let memoryRefs: string[] = input.memoryRefs ?? [];
	let status: SessionState['status'] = 'idle';
	/** Set to true by cancelRun signal; causes the main loop to exit cleanly. */
	let cancelled = false;

	// ── Query handlers ───────────────────────────────────────────────────────

	void setHandler(
		getSessionStateQuery,
		(): SessionState => ({
			sessionKey,
			status,
			activeRunId,
			queueDepth: queue.length,
			completedRunCount
		})
	);

	void setHandler(getActiveRunQuery, (): { runId: string } | null =>
		activeRunId ? { runId: activeRunId } : null
	);

	// The session does not directly observe the run's internal approval state.
	// Callers that need real-time approval state should query the active run
	// workflow's getAgentRunState directly.
	void setHandler(getPendingApprovalsQuery, (): ApprovalCardState[] => []);

	void setHandler(getMemorySnapshotQuery, (): SessionMemorySnapshot => ({ memoryRefs }));

	void setHandler(
		getSandboxSnapshotQuery,
		(): SessionSandboxSnapshot => ({
			sessionKey,
			workspacePath: null
		})
	);

	// ── Update handlers ──────────────────────────────────────────────────────

	void setHandler(submitTurnUpdate, (turn: SubmitTurnInput): SubmitTurnResult => {
		submittedTurnCount++;
		const runId = `${sessionKey}-run-${submittedTurnCount}`;
		queue.push({ runId, message: turn.message });
		return { accepted: true, runId };
	});

	void setHandler(
		submitSteeringUpdate,
		async (steeringInput: SubmitSteeringInput): Promise<SubmitSteeringResult> => {
			if (!activeRunId) {
				return { accepted: false, reason: 'No active run to steer' };
			}
			const handle = getExternalWorkflowHandle(`agent-run:${activeRunId}`);
			await handle.signal(steeringSignal, steeringInput.message);
			return { accepted: true };
		}
	);

	void setHandler(interruptRunUpdate, (interruptInput: InterruptRunInput): InterruptRunResult => {
		if (!activeRunId) {
			return { interrupted: false };
		}
		// Cancel the active run's scope; the executeChild awaiting it will throw
		// CancelledFailure, which the main loop catches and suppresses.
		activeRunScope?.cancel();
		if (interruptInput.replacement) {
			submittedTurnCount++;
			const replacementRunId = `${sessionKey}-run-${submittedTurnCount}`;
			queue.push({ runId: replacementRunId, message: interruptInput.replacement });
			return { interrupted: true, replacementRunId };
		}
		return { interrupted: true };
	});

	// ── Signal handlers ──────────────────────────────────────────────────────

	void setHandler(cancelRunSignal, () => {
		cancelled = true;
		// Cancel the active run scope if a run is in flight.
		activeRunScope?.cancel();
	});

	void setHandler(streamDisconnectedSignal, () => {
		// No-op: streaming state is managed on the client side; the workflow
		// does not need to react to a disconnected stream subscriber.
	});

	// ── Main loop ────────────────────────────────────────────────────────────

	while (!cancelled) {
		status = 'idle';
		const timedOut = !(await condition(() => queue.length > 0 || cancelled, SESSION_IDLE_TTL_MS));
		if (timedOut || cancelled) break;

		status = 'active';
		while (queue.length > 0 && !cancelled) {
			const turn = queue.shift()!;
			activeRunId = turn.runId;
			let runResult: AgentRunResult | undefined;

			try {
				await CancellationScope.cancellable(async () => {
					activeRunScope = CancellationScope.current();
					runResult = await executeChild(agentRunWorkflow, {
						workflowId: `agent-run:${turn.runId}`,
						args: [
							{
								sessionKey,
								runId: turn.runId,
								message: turn.message
							} satisfies AgentRunInput
						]
					});
				});
				// Run completed successfully — accumulate memory refs.
				completedRunCount++;
				if (runResult?.memoryRefs?.length) {
					memoryRefs = [...memoryRefs, ...runResult.memoryRefs];
				}
			} catch (e: unknown) {
				if (isCancellation(e)) {
					// Run was interrupted or cancelled — do not propagate.
					// The session either picks up the next queued turn or exits
					// depending on the `cancelled` flag.
				} else {
					throw e;
				}
			} finally {
				activeRunId = null;
				activeRunScope = undefined;
			}

			// Check for Continue-As-New between runs, when the queue is empty.
			// Never attempt CAN while more turns are queued — that would lose them.
			// replay-tested: 2026-06-26
			if (!cancelled && queue.length === 0) {
				const info = workflowInfo();
				if (info.continueAsNewSuggested || info.historyLength >= canThreshold) {
					// Wait for any in-flight update handlers (e.g. submitSteering)
					// to finish before handing off to the new execution.
					await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
					await continueAsNew<typeof agentSessionWorkflow>({
						sessionKey,
						completedRunCount,
						submittedTurnCount,
						memoryRefs,
						canHistoryThreshold: canThreshold
					});
					// continueAsNew never returns; the line below is unreachable.
				}
			}
		}
	}

	status = 'complete';
}
