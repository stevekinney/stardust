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
	toolCalls?: ToolCallInput[];
	workspacePath?: string;
	approvalTtlMs?: number;
	delegateSubagents?: boolean;
	budget?: ModelUsage;
};

export type AgentRunResult = {
	runId: string;
	status: 'complete' | 'failed' | 'cancelled';
	finalAnswer: string;
	budgetLedger?: BudgetLedgerSnapshot;
	timelineLanes?: RunTimelineLane[];
	criticAnnotations?: CriticAnnotation[];
};

export type BudgetLedgerEntry = {
	workflowId: string;
	laneId: string;
	label: string;
	usage: ModelUsage;
};

export type BudgetLedgerSnapshot = {
	limit: ModelUsage;
	used: ModelUsage;
	remaining: ModelUsage;
	entries: BudgetLedgerEntry[];
};

export type CriticAnnotation = {
	id: string;
	laneId: string;
	message: string;
	blocking: false;
};

export type RunTimelineLane = {
	id: string;
	label: string;
	kind: 'parent' | 'subagent';
	status: 'running' | 'complete' | 'failed' | 'cancelled';
	budget?: ModelUsage;
	children?: RunTimelineLane[];
	annotations?: CriticAnnotation[];
};

export type SubagentKind = 'research' | 'code' | 'critic';

export type SubagentWorkflowInput = {
	parentRunId: string;
	subagentRunId: string;
	kind: SubagentKind;
	message: string;
	finalAnswer?: string;
	budgetDebit: BudgetLedgerEntry;
};

export type SubagentWorkflowResult = {
	parentRunId: string;
	subagentRunId: string;
	kind: SubagentKind;
	status: 'complete' | 'failed' | 'cancelled';
	finalAnswer: string;
	budgetDebit: BudgetLedgerEntry;
	timelineLane: RunTimelineLane;
	annotations?: CriticAnnotation[];
};

export type ScheduledAgentInput = {
	scheduleId: string;
	prompt: string;
};

export type CreateScheduleInput = {
	name: string;
	description?: string;
	cronExpression: string;
	prompt: string;
};

export type ScheduleProjection = {
	id: string;
	temporalScheduleId: string;
	targetSessionKey: string;
	name: string;
	description: string | null;
	cronExpression: string;
	prompt: string;
	status: 'active' | 'paused' | 'deleted';
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type TriggerScheduleResult = {
	schedule: ScheduleProjection;
	targetSessionKey: string;
};

export type DeleteScheduleResult = {
	scheduleId: string;
	deleted: true;
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
	idempotencyKey?: string;
};

export type ToolPolicyDecision =
	| { status: 'allowed'; tool: ToolManifestEntry }
	| { status: 'approval_required'; tool: ToolManifestEntry; policyVersion: string }
	| { status: 'denied'; reason: string };

export type ToolExecutionInput = {
	call: ToolCallInput;
	sessionId?: string;
	runId?: string;
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
		idempotencyKey?: string;
		idempotencyReplayed?: boolean;
	};
};

export type ApprovalTerminalState = 'approved' | 'denied' | 'remembered' | 'cancelled' | 'expired';

export type ApprovalAction =
	| 'approve'
	| 'approve_with_edits'
	| 'deny'
	| 'remember'
	| 'cancel'
	| 'expire';

export type ApprovalRequest = {
	approvalId: string;
	sessionId: string;
	runId: string;
	toolCall: ToolCallInput;
	tool: ToolManifestEntry;
	policyVersion: string;
	proposedArguments: unknown;
	argsHash: string;
	expiresAt: string;
	createdAt: string;
};

export type ApprovalResolutionInput = {
	approvalId: string;
	action: Exclude<ApprovalAction, 'expire'>;
	editedArguments?: unknown;
	reason?: string;
	remember?: boolean;
	actor?: 'user';
};

export type ApprovalResolution = {
	approvalId: string;
	action: ApprovalAction;
	terminalState: ApprovalTerminalState;
	canonicalArguments: unknown;
	proposedArguments: unknown;
	editedArguments?: unknown;
	reason?: string;
	remember: boolean;
	actor: 'system' | 'user';
	resolvedAt: string;
};

export type ApprovalCardState = ApprovalRequest & {
	status: 'pending' | ApprovalTerminalState;
	resolution?: ApprovalResolution;
};

export type RecordApprovalRequestInput = Omit<ApprovalRequest, 'argsHash' | 'createdAt'> & {
	createdAt?: string;
};

export type RecordApprovalResolutionInput = {
	approvalId: string;
	action: ApprovalAction;
	editedArguments?: unknown;
	reason?: string;
	remember?: boolean;
	actor: 'system' | 'user';
	resolvedAt?: string;
};

export type CompactMemoryInput = {
	sessionId: string;
	fromTranscriptCursor: number;
	reason: 'threshold' | 'manual';
};

export type LoadedMemoryCompactionInput = {
	sessionId: string;
	fromTranscriptCursor: number;
	toTranscriptCursor: number;
	transcript: string[];
	existingMemoryRefs: string[];
};

export type MemoryCompactionCandidate = {
	layer: 'session' | 'durable' | 'action_sensitive';
	content: string;
	tags?: string[];
	reason?: string | null;
};

export type MemoryCompactionSummary = {
	summary: string;
	candidates: MemoryCompactionCandidate[];
};

export type PersistMemoryCompactionInput = LoadedMemoryCompactionInput & MemoryCompactionSummary;

export type CompactMemoryResult = {
	sessionId: string;
	summaryNoteId: string;
	candidateIds: string[];
	memoryRefs: string[];
	transcriptCursor: number;
};

export type MemoryCompactionActivities = {
	loadMemoryCompactionInput(input: CompactMemoryInput): Promise<LoadedMemoryCompactionInput>;
	summarizeMemoryCompaction(input: LoadedMemoryCompactionInput): Promise<MemoryCompactionSummary>;
	persistMemoryCompaction(input: PersistMemoryCompactionInput): Promise<CompactMemoryResult>;
};

// Task queue name constants — kept here (not in src/lib/server) so Workflow code can import them.
export const TASK_QUEUE_ORCHESTRATOR = 'agent-orchestrator';
export const TASK_QUEUE_MODEL = 'model-calls';
export const TASK_QUEUE_TOOLS = 'tools-general';
export const TASK_QUEUE_SANDBOX = 'tools-sandbox';
export const TASK_QUEUE_MEMORY = 'memory';
