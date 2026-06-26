import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS,
	type ToolMetadata,
	type ToolRiskLevel
} from '@src/lib/types';

export const POLICY_VERSION = '2026-06-26';

export function toolMetadata(input: ToolMetadata): ToolMetadata {
	return input;
}

export const LOW_RISK_TOOL: ToolMetadata = toolMetadata({
	risk: 'low',
	requiresApproval: false,
	taskQueue: TASK_QUEUE_TOOLS,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 2 }
});

export const MUTATING_WORKSPACE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 15_000,
	retry: { maximumAttempts: 1 }
});

export const SHELL_EXEC_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 }
});

export const PROCESS_START_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 30_000,
	retry: { maximumAttempts: 1 }
});

export const PROCESS_KILL_TOOL: ToolMetadata = toolMetadata({
	risk: 'high',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 1 }
});

export const SANDBOX_SNAPSHOT_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_SANDBOX,
	timeoutMs: 20_000,
	retry: { maximumAttempts: 1 }
});

export const MEMORY_WRITE_CANDIDATE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_MEMORY,
	timeoutMs: 10_000,
	retry: { maximumAttempts: 1 }
});

export const DELEGATE_TOOL: ToolMetadata = toolMetadata({
	risk: 'medium',
	requiresApproval: true,
	taskQueue: TASK_QUEUE_ORCHESTRATOR,
	timeoutMs: 60_000,
	retry: { maximumAttempts: 1 }
});

export function riskRequiresApproval(risk: ToolRiskLevel): boolean {
	return risk === 'medium' || risk === 'high';
}
