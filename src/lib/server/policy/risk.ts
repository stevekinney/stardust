import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS,
	type ToolMetadata,
	type ToolRiskLevel
} from '@src/lib/types';

export const POLICY_VERSION = '2026-06-26';

/** Identity function — lets callers get full type-checking on metadata literals. */
export function toolMetadata(input: ToolMetadata): ToolMetadata {
	return input;
}

/** Read-only tools: safe to replay without an idempotency key. */
export const LOW_RISK_TOOL: ToolMetadata = toolMetadata({
	risk: 'low',
	requiresApproval: false,
	taskQueue: TASK_QUEUE_TOOLS,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 2 },
	idempotencyBehavior: 'safe'
});

/**
 * Mutating workspace tools (`workspace.writeFile`, `workspace.applyPatch`).
 * Risk is High per the MVP spec — these overwrite or patch files and require approval.
 * An idempotency key is required so that Temporal retries do not double-apply a write.
 */
export const MUTATING_WORKSPACE_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/**
 * Arbitrary shell execution — risk is High and idempotency cannot be guaranteed
 * because commands typically have unrepeatable side effects.
 */
export const SHELL_EXEC_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'unsafe'
});

/** Long-running process launch — deduplication via idempotency key prevents double-start. */
export const PROCESS_START_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/**
 * Process kill — risk is Medium per the MVP spec.
 * Kill signals are state-dependent (process may already be gone), so idempotency is unsafe.
 */
export const PROCESS_KILL_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'unsafe'
});

/** Sandbox git-commit snapshot — key-required to prevent duplicate snapshot commits on retry. */
export const SANDBOX_SNAPSHOT_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 20_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Memory candidate proposal — key-required to avoid duplicate candidate rows on retry. */
export const MEMORY_WRITE_CANDIDATE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_MEMORY,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Delegate child-workflow launch — key-required to prevent duplicate child executions on retry. */
export const DELEGATE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_ORCHESTRATOR,
	timeoutMs: 60_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

export function riskRequiresApproval(risk: ToolRiskLevel): boolean {
	return risk === 'medium' || risk === 'high';
}
