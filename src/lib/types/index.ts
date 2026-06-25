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

// Task queue name constants — kept here (not in src/lib/server) so Workflow code can import them.
export const TASK_QUEUE_ORCHESTRATOR = 'agent-orchestrator';
export const TASK_QUEUE_MODEL = 'model-calls';
export const TASK_QUEUE_TOOLS = 'tools-general';
export const TASK_QUEUE_SANDBOX = 'tools-sandbox';
export const TASK_QUEUE_MEMORY = 'memory';
