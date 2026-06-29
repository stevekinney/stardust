import type {
	AgentRunInput,
	AgentRunResult,
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput,
	CompactMemoryInput,
	InterruptRunInput,
	InterruptRunResult,
	ModelToolSchema,
	SessionMemorySnapshot,
	SessionSandboxSnapshot,
	SessionState,
	SubmitSteeringInput,
	SubmitSteeringResult,
	SubmitTurnInput,
	SubmitTurnResult,
	ToolManifestEntry
} from '@src/lib/types';
import {
	CancellationScope,
	allHandlersFinished,
	condition,
	continueAsNew,
	executeChild,
	getExternalWorkflowHandle,
	isCancellation,
	proxyActivities,
	setHandler,
	workflowInfo
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import { steeringSignal } from './approval-contracts';
import { DEFAULT_RUN_BUDGET, agentRunWorkflow } from './agent-run.workflow';
import { memoryCompactionWorkflow } from './memory-compaction.workflow';
import {
	cancelRunSignal,
	getActiveRunQuery,
	getMemorySnapshotQuery,
	getPendingApprovalsQuery,
	getSandboxSnapshotQuery,
	getSessionStateQuery,
	interruptRunUpdate,
	resolveApprovalUpdate,
	streamDisconnectedSignal,
	submitSteeringUpdate,
	submitTurnUpdate
} from './session-contracts';

// ── Activity proxies ───────────────────────────────────────────────────────────

// Inline string to avoid importing a runtime value from @src/lib/types across
// the workflow sandbox boundary. Matches TASK_QUEUE_TOOLS ('tools-general').
const TASK_QUEUE_TOOLS = 'tools-general';

type ForwardApprovalActivities = {
	forwardApprovalToRun(input: {
		runId: string;
		resolution: ApprovalResolutionInput;
	}): Promise<ApprovalResolution>;
};

const forwardApprovalActivities = proxyActivities<ForwardApprovalActivities>({
	taskQueue: TASK_QUEUE_TOOLS,
	startToCloseTimeout: '30 seconds',
	retry: { maximumAttempts: 1 }
});

type PolicyActivities = {
	listToolManifest(input?: { allowedToolNames?: string[] }): Promise<ToolManifestEntry[]>;
};

const policyActivities = proxyActivities<PolicyActivities>({
	taskQueue: TASK_QUEUE_TOOLS,
	startToCloseTimeout: '30 seconds',
	retry: { maximumAttempts: 3 }
});

/** Maps a ToolManifestEntry to the ModelToolSchema shape expected by AgentRunInput. */
function toModelToolSchema(entry: ToolManifestEntry): ModelToolSchema {
	return {
		identity: { name: entry.name },
		display: { description: entry.description },
		input: entry.inputSchema
	};
}

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

type QueuedTurn = {
	runId: string;
	message: string;
	delegateSubagents?: boolean;
	/** Model ID from the user's settings at the time of submission. */
	model?: string;
	/**
	 * Per-run cost cap from the user's settings. When > 0, overrides
	 * `maxEstimatedCostUsd` in DEFAULT_RUN_BUDGET. When 0 or absent, the default
	 * $1 cap applies (0 does NOT disable budgeting).
	 */
	maxBudgetUsd?: number;
};

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
	 * Carried across Continue-As-New: turns still queued at the moment of handoff.
	 * A turn submitted during the pre-CAN compaction/handler-drain await would
	 * otherwise be lost, since the new execution starts with an empty queue.
	 */
	queue?: QueuedTurn[];
	/**
	 * Carried across Continue-As-New: the transcript sequence cursor advanced by the
	 * last memory compaction. Passed as `fromTranscriptCursor` to the next compaction
	 * so it only re-reads events written since the previous compaction.
	 */
	memoryCursor?: number;
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

	const queue: QueuedTurn[] = input.queue ?? [];
	let activeRunId: string | null = null;
	/** CancellationScope for the currently executing child run; undefined when idle. */
	let activeRunScope: CancellationScope | undefined;
	let completedRunCount = input.completedRunCount ?? 0;
	let submittedTurnCount = input.submittedTurnCount ?? 0;
	let memoryRefs: string[] = input.memoryRefs ?? [];
	/** Transcript sequence cursor advanced after each compaction; carried across CAN. */
	let memoryCursor = input.memoryCursor ?? 0;
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
		queue.push({
			runId,
			message: turn.message,
			delegateSubagents: turn.delegateSubagents,
			model: turn.model,
			maxBudgetUsd: turn.maxBudgetUsd
		});
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

	void setHandler(
		resolveApprovalUpdate,
		async (resolution: ApprovalResolutionInput): Promise<ApprovalResolution> => {
			if (!activeRunId) {
				throw ApplicationFailure.nonRetryable('No active run to forward approval resolution to');
			}
			// Route the resolution through the tools-worker activity, which uses the
			// Temporal client to call resolveApprovalUpdate on the active run.
			// getExternalWorkflowHandle supports only signal/cancel, not executeUpdate,
			// so the activity bridge is necessary.
			return forwardApprovalActivities.forwardApprovalToRun({
				runId: activeRunId,
				resolution
			});
		}
	);

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
			let runResult: AgentRunResult | undefined;

			try {
				await CancellationScope.cancellable(async () => {
					activeRunScope = CancellationScope.current();
					// Fetch the tool manifest once per turn so the model always has the
					// current set of available tools. Fetched inside the CancellationScope
					// so a cancelRunSignal during the fetch cancels the activity rather
					// than letting it complete and launching the run anyway.
					const toolManifest = await policyActivities.listToolManifest();
					const tools = toolManifest.map(toModelToolSchema);
					activeRunId = turn.runId;
					runResult = await executeChild(agentRunWorkflow, {
						workflowId: `agent-run:${turn.runId}`,
						args: [
							{
								sessionKey,
								runId: turn.runId,
								message: turn.message,
								delegateSubagents: turn.delegateSubagents,
								tools,
								...(turn.model !== undefined ? { model: turn.model } : {}),
								...(turn.maxBudgetUsd !== undefined && turn.maxBudgetUsd > 0
									? {
											budget: {
												...DEFAULT_RUN_BUDGET,
												maxEstimatedCostUsd: turn.maxBudgetUsd
											}
										}
									: {})
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
					// The run workflow threw a non-cancellation error (the run workflow
					// already persisted status='failed' before re-throwing). Count it as
					// a completed run so the session loop continues and is not bricked —
					// the session must remain able to accept subsequent turns.
					completedRunCount++;
					// runResult is undefined here; no memory refs to accumulate.
				}
			} finally {
				activeRunId = null;
				activeRunScope = undefined;
			}

			// Check for Continue-As-New between runs, when the queue is empty.
			// Never attempt CAN while more turns are queued — that would lose them.
			// replay-tested: 2026-06-27
			if (!cancelled && queue.length === 0) {
				const info = workflowInfo();
				if (info.continueAsNewSuggested || info.historyLength >= canThreshold) {
					// Compact memory before crossing the CAN boundary so the next
					// execution starts with a condensed ref set and advanced cursor.
					// Deliberate failure policy: if compaction fails after all activity
					// retries, the error propagates and the session execution fails
					// rather than silently losing the compaction. This is preferable
					// to a stale memoryRefs set growing without bound across CAN cycles.
					const compactionResult = await executeChild(memoryCompactionWorkflow, {
						workflowId: `memory-compaction:${sessionKey}:can-${completedRunCount}`,
						args: [
							{
								sessionId: sessionKey,
								fromTranscriptCursor: memoryCursor,
								reason: 'threshold'
							} satisfies CompactMemoryInput
						]
					});
					memoryRefs = compactionResult.memoryRefs;
					memoryCursor = compactionResult.transcriptCursor;

					// Wait for any in-flight update handlers (e.g. submitSteering) that
					// arrived during compaction to finish before handing off to the new
					// execution. Placed after executeChild so compaction does not race
					// with handlers that fire while it is awaited.
					await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);

					// Carry the queue: a submitTurn that arrived during the compaction or
					// handler-drain awaits above pushed onto `queue`, and `continueAsNew`
					// is the next statement with no await in between, so the snapshot is
					// current. Without this, those turns would be silently dropped.
					await continueAsNew<typeof agentSessionWorkflow>({
						sessionKey,
						completedRunCount,
						submittedTurnCount,
						memoryRefs,
						memoryCursor,
						queue,
						canHistoryThreshold: canThreshold
					});
					// continueAsNew never returns; the line below is unreachable.
				}
			}
		}
	}

	// Drain any in-flight async update handlers (e.g. submitSteering) before
	// completing, so a steering update mid-flight at session end does not produce
	// an unfinished-handler warning.
	status = 'finalizing';
	await condition(allHandlersFinished, HANDLER_FINISH_TIMEOUT_MS);
	status = 'complete';
}
