// Serializable contracts and Zod schemas shared across UI, API routes, Workflows, and Activities.
// Must not import SDK clients, DB client, or UI libraries.

export type SubmitTurnInput = {
	message: string;
};

export type SubmitTurnResult = {
	accepted: boolean;
	runId: string;
};

export type SessionState = {
	sessionKey: string;
	status: 'active' | 'idle' | 'finalizing' | 'complete';
	activeRunId: string | null;
	queueDepth: number;
	completedRunCount: number;
};

export type AgentRunInput = {
	sessionKey: string;
	runId: string;
	message: string;
};

export type AgentRunResult = {
	runId: string;
	status: 'complete' | 'failed' | 'cancelled';
	finalAnswer: string;
};

export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
};

export type ModelToolSchema = {
	identity: {
		name: string;
		namespace?: string;
		version?: string;
	};
	display: {
		description: string;
		title?: string;
	};
	input: Record<string, unknown>;
};

export type ModelCallInput = {
	sessionId: string;
	runId: string;
	model: string;
	tools?: ModelToolSchema[];
	maxTokens?: number;
	systemPrompt?: string;
};

export type NormalizedToolCall = {
	id: string;
	name: string;
	input: unknown;
};

export type NormalizedModelMessage = {
	text: string;
	toolCalls: NormalizedToolCall[];
};

export type ModelCallResult = {
	runId: string;
	model: string;
	message: NormalizedModelMessage;
	usage: ModelUsage;
};

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type ToolMetadata = {
	risk: ToolRiskLevel;
	requiresApproval: boolean;
	taskQueue: string;
	timeoutMs: number;
	retry: {
		maximumAttempts: number;
	};
};

export type ToolManifestEntry = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	metadata: ToolMetadata;
};

export type ToolCallInput = {
	id: string;
	name: string;
	arguments: unknown;
};

export type ToolPolicyDecision =
	| { status: 'allowed'; tool: ToolManifestEntry }
	| { status: 'approval_required'; tool: ToolManifestEntry; policyVersion: string }
	| { status: 'denied'; reason: string };

export type ToolExecutionInput = {
	call: ToolCallInput;
	workspacePath?: string;
};

export type ToolExecutionResult = {
	callId: string;
	toolName: string;
	outcome: 'success' | 'error' | 'approval_required' | 'denied';
	content: unknown;
	metadata?: {
		truncated?: boolean;
		originalCharacters?: number;
	};
};

// Task queue name constants — kept here (not in src/lib/server) so Workflow code can import them.
export const TASK_QUEUE_ORCHESTRATOR = 'agent-orchestrator';
export const TASK_QUEUE_MODEL = 'model-calls';
export const TASK_QUEUE_TOOLS = 'tools-general';
export const TASK_QUEUE_SANDBOX = 'tools-sandbox';
export const TASK_QUEUE_MEMORY = 'memory';
