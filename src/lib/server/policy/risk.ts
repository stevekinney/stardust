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

/** Read-only repository, browser, Temporal, and artifact inspection tools. */
export const REPOSITORY_INSPECT_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 15_000
});

export const BROWSER_INSPECT_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 }
});

export const TEMPORAL_MCP_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 }
});

export const SAFE_ARTIFACT_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 1 }
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

/** Sandbox restore rewrites workspace state to a prior git snapshot. */
export const SANDBOX_RESTORE_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 20_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Structured verification commands execute project scripts and may mutate caches. */
export const VERIFICATION_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'unsafe'
});

/** Browser actions can mutate application state through UI interactions. */
export const BROWSER_ACTION_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'unsafe'
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

/** Keyless public-data reads (feeds, Hacker News, weather, Wikipedia, docs lookup). */
export const PUBLIC_DATA_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 15_000
});

/** Remote documentation lookup (Context7) — read-only but slower than local reads. */
export const DOCS_LOOKUP_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 }
});

/**
 * Durable timer — executed by the orchestrator workflow itself (like
 * `delegate.parallel`), never inside a tool activity. Low risk: waiting has no
 * side effects and cancellation interrupts it.
 */
export const TIMER_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	taskQueue: TASK_QUEUE_ORCHESTRATOR
});

/** Creating a standing Temporal schedule is a durable action — approval + dedupe required. */
export const SCHEDULE_CREATE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_TOOLS,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Cross-session messaging wakes or feeds another session — approval + dedupe required. */
export const SESSION_MESSAGE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_TOOLS,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Native desktop notification — local, transient, no approval needed. */
export const NOTIFY_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	retry: { maximumAttempts: 1 }
});

/** iMessage send — outward-facing message to a real person; approval + dedupe required. */
export const MESSAGING_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_TOOLS,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'key-required'
});

/** Raw Playwright MCP calls can mutate page state through UI interactions. */
export const BROWSER_MCP_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 60_000,
	retry: { maximumAttempts: 1 },
	idempotencyBehavior: 'unsafe'
});

/** Per-session scratch SQLite — contained to a dedicated database file, no approval. */
export const DB_QUERY_TOOL: ToolMetadata = toolMetadata({
	...LOW_RISK_TOOL,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 }
});

export function riskRequiresApproval(risk: ToolRiskLevel): boolean {
	return risk === 'medium' || risk === 'high';
}
