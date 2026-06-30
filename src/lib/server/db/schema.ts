import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── sessions ─────────────────────────────────────────────────────────────────
// One row per logical resumable conversation thread. Maps 1:1 to AgentSessionWorkflow.
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	sessionKey: text('session_key').notNull().unique(),
	status: text('status', { enum: ['active', 'idle', 'finalizing', 'complete'] })
		.notNull()
		.default('active'),
	workflowId: text('workflow_id').notNull(),
	summaryCursor: integer('summary_cursor').default(0),
	memoryRefs: text('memory_refs'), // JSON array of memory_notes.id
	/** Human-readable label for the session. Falls back to sessionKey when null. */
	name: text('name'),
	/** ISO timestamp set when the session is archived; null means not archived. */
	archivedAt: text('archived_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── runs ──────────────────────────────────────────────────────────────────────
// One prepared turn executed by AgentRunWorkflow.
export const runs = sqliteTable('runs', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	workflowId: text('workflow_id').notNull(),
	status: text('status', {
		enum: ['pending', 'running', 'waiting_approval', 'complete', 'failed', 'cancelled']
	})
		.notNull()
		.default('pending'),
	model: text('model'),
	input: text('input'), // JSON: user message + context refs
	finalAnswer: text('final_answer'),
	usage: text('usage'), // JSON: { inputTokens, outputTokens, estimatedCostUsd }
	budget: text('budget'), // JSON: RunBudget snapshot
	error: text('error'),
	startedAt: text('started_at'),
	completedAt: text('completed_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── transcript_events ─────────────────────────────────────────────────────────
// Canonical truth: every message, tool call, approval, and lifecycle event.
export const transcriptEvents = sqliteTable('transcript_events', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id').notNull(),
	sequence: integer('sequence').notNull(),
	kind: text('kind', {
		enum: [
			'user_message',
			'assistant_message',
			'tool_call',
			'tool_result',
			'approval_request',
			'approval_resolution',
			'lifecycle'
		]
	}).notNull(),
	payload: text('payload').notNull(), // JSON
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── audit_events ──────────────────────────────────────────────────────────────
// Policy, approval, cancellation, retry, and operator action audit trail.
export const auditEvents = sqliteTable('audit_events', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id'),
	kind: text('kind', {
		enum: [
			'policy_check',
			'approval_request',
			'approval_resolution',
			'cancellation',
			'retry',
			'operator_action'
		]
	}).notNull(),
	toolCallId: text('tool_call_id'),
	argsHash: text('args_hash'),
	editedArgs: text('edited_args'), // JSON
	policyVersion: text('policy_version'),
	actor: text('actor', { enum: ['system', 'user'] })
		.notNull()
		.default('system'),
	payload: text('payload').notNull(), // JSON
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── approval_requests ─────────────────────────────────────────────────────────
// Durable projection of a human approval wait owned by AgentRunWorkflow.
export const approvalRequests = sqliteTable('approval_requests', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id').notNull(),
	toolCallId: text('tool_call_id').notNull(),
	toolName: text('tool_name').notNull(),
	status: text('status', {
		enum: ['pending', 'approved', 'denied', 'remembered', 'cancelled', 'expired']
	})
		.notNull()
		.default('pending'),
	proposedArgs: text('proposed_args').notNull(), // JSON
	canonicalArgs: text('canonical_args'), // JSON
	argsHash: text('args_hash').notNull(),
	editedArgs: text('edited_args'), // JSON
	reason: text('reason'),
	remember: integer('remember', { mode: 'boolean' }).notNull().default(false),
	policyVersion: text('policy_version').notNull(),
	expiresAt: text('expires_at').notNull(),
	resolvedAt: text('resolved_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── memory_notes ──────────────────────────────────────────────────────────────
// Durable + action-sensitive memory. FTS5 mirror in memory_notes_fts (virtual, see migration).
export const memoryNotes = sqliteTable('memory_notes', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	kind: text('kind', {
		enum: ['session_summary', 'durable', 'action_sensitive']
	}).notNull(),
	content: text('content').notNull(),
	embeddingModel: text('embedding_model'),
	tags: text('tags'), // JSON string[]
	runId: text('run_id'),
	confirmedAt: text('confirmed_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── tool_invocations ──────────────────────────────────────────────────────────
// Provider-agnostic tool lifecycle ledger, one row per tool_call_id.
export const toolInvocations = sqliteTable('tool_invocations', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id').notNull(),
	toolCallId: text('tool_call_id').notNull().unique(),
	toolName: text('tool_name').notNull(),
	args: text('args').notNull(), // JSON
	argsHash: text('args_hash').notNull(),
	idempotencyKey: text('idempotency_key'),
	status: text('status', {
		enum: ['pending', 'approved', 'denied', 'running', 'complete', 'failed', 'timeout']
	})
		.notNull()
		.default('pending'),
	resultRef: text('result_ref'), // artifact id if result was spilled
	resultInline: text('result_inline'), // JSON if inline
	risk: text('risk', { enum: ['low', 'medium', 'high'] })
		.notNull()
		.default('low'),
	taskQueue: text('task_queue').notNull(),
	startedAt: text('started_at'),
	completedAt: text('completed_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── artifacts ─────────────────────────────────────────────────────────────────
// Files, patches, screenshots, logs, and large tool outputs.
export const artifacts = sqliteTable('artifacts', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id').notNull(),
	toolCallId: text('tool_call_id'),
	objectKey: text('object_key').notNull().unique(),
	storageProvider: text('storage_provider').notNull().default('local'),
	mimeType: text('mime_type').notNull(),
	sizeBytes: integer('size_bytes').notNull(),
	metadata: text('metadata'), // JSON
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── sandboxes ─────────────────────────────────────────────────────────────────
// Local subprocess sandbox records (one per session).
export const sandboxes = sqliteTable('sandboxes', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	name: text('name').notNull().unique(), // sd-{sessionKey}
	provider: text('provider').notNull().default('local-subprocess'),
	workspacePath: text('workspace_path').notNull(),
	status: text('status', { enum: ['active', 'suspended', 'terminated'] })
		.notNull()
		.default('active'),
	gitInitialized: integer('git_initialized', { mode: 'boolean' }).notNull().default(false),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── sandbox_snapshots ─────────────────────────────────────────────────────────
// Git-commit snapshots of workspace state before risky mutations.
export const sandboxSnapshots = sqliteTable('sandbox_snapshots', {
	id: text('id').primaryKey(),
	sandboxId: text('sandbox_id').notNull(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id'),
	toolCallId: text('tool_call_id'),
	externalSnapshotId: text('external_snapshot_id').notNull(), // git SHA
	reason: text('reason'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── sandbox_commands ──────────────────────────────────────────────────────────
// Detail rows for sandbox-executed tools. Joined to tool_invocations by tool_call_id.
export const sandboxCommands = sqliteTable('sandbox_commands', {
	id: text('id').primaryKey(),
	sandboxId: text('sandbox_id').notNull(),
	sessionId: text('session_id').notNull(),
	runId: text('run_id').notNull(),
	toolCallId: text('tool_call_id'),
	command: text('command').notNull(),
	args: text('args'), // JSON string[]
	status: text('status', {
		enum: ['pending', 'running', 'complete', 'failed', 'timeout', 'killed']
	})
		.notNull()
		.default('pending'),
	exitCode: integer('exit_code'),
	stdoutRef: text('stdout_ref'),
	stderrRef: text('stderr_ref'),
	startedAt: text('started_at'),
	completedAt: text('completed_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString())
});

// ── schedules ─────────────────────────────────────────────────────────────────
// UI projection of Temporal Schedules for recurring agent runs.
export const schedules = sqliteTable('schedules', {
	id: text('id').primaryKey(),
	temporalScheduleId: text('temporal_schedule_id').notNull().unique(),
	targetSessionKey: text('target_session_key').notNull(),
	name: text('name').notNull(),
	description: text('description'),
	cronExpression: text('cron_expression').notNull(),
	prompt: text('prompt').notNull(),
	status: text('status', { enum: ['active', 'paused', 'deleted'] })
		.notNull()
		.default('active'),
	lastRunAt: text('last_run_at'),
	nextRunAt: text('next_run_at'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	updatedAt: text('updated_at').notNull().default(new Date(0).toISOString())
});

// ── stream_events ─────────────────────────────────────────────────────────────
// Live stream bus (replaces Redis Streams). WAL mode lets Worker write while SSE route reads.
export const streamEvents = sqliteTable(
	'stream_events',
	{
		id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
		runId: text('run_id').notNull(),
		sessionId: text('session_id').notNull(),
		sequence: integer('sequence').notNull(),
		deduplicationKey: text('deduplication_key'),
		kind: text('kind', {
			enum: [
				'assistant.delta',
				'assistant.message',
				'tool.call',
				'tool.result',
				'lifecycle',
				'approval.request',
				'approval.resolution',
				'memory.candidate',
				'subagent.start',
				'subagent.complete',
				'sandbox.output'
			]
		}).notNull(),
		payload: text('payload').notNull(), // JSON
		createdAt: text('created_at').notNull().default(new Date(0).toISOString())
	},
	(table) => [
		// Enforces monotonic per-run sequence authority: no two events for the same
		// run may share a sequence number, preventing duplicates under concurrent writes.
		uniqueIndex('stream_events_run_id_sequence_unique').on(table.runId, table.sequence),
		uniqueIndex('stream_events_run_id_deduplication_key_unique').on(
			table.runId,
			table.deduplicationKey
		)
	]
);

// ── idempotency_ledger ────────────────────────────────────────────────────────
// Prevents duplicate external side effects on Activity retry.
export const idempotencyLedger = sqliteTable('idempotency_ledger', {
	id: text('id').primaryKey(),
	idempotencyKey: text('idempotency_key').notNull().unique(),
	runId: text('run_id').notNull(),
	toolCallId: text('tool_call_id'),
	status: text('status', { enum: ['pending', 'complete', 'failed'] })
		.notNull()
		.default('pending'),
	resultRef: text('result_ref'),
	createdAt: text('created_at').notNull().default(new Date(0).toISOString()),
	completedAt: text('completed_at')
});
