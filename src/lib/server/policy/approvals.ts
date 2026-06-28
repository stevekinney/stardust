import { asc, desc, eq } from 'drizzle-orm';
import type {
	ApprovalAction,
	ApprovalCardState,
	ApprovalResolution,
	ApprovalTerminalState,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	ToolManifestEntry
} from '@src/lib/types';
import { TASK_QUEUE_SANDBOX } from '@src/lib/types';
import type { DatabaseClient } from '../db/client';
import { approvalRequests, auditEvents, runs } from '../db/schema';
import { appendTranscriptEvent, publishStreamEvent } from '../stream';
import { registeredTools } from '../tools/registry';
import { hashApprovalArguments } from './arguments-hash';

/** Module-level lookup map so the linear scan runs once at startup, not per row. */
const toolsByName = new Map<string, ToolManifestEntry>(
	registeredTools.map((t) => [
		t.name,
		{ name: t.name, description: t.description, inputSchema: t.inputSchema, metadata: t.metadata }
	])
);

type ApprovalRequestRow = typeof approvalRequests.$inferSelect;

function parseJson(value: string | null): unknown {
	return value === null ? undefined : (JSON.parse(value) as unknown);
}

function terminalStateForAction(action: ApprovalAction): ApprovalTerminalState {
	switch (action) {
		case 'approve':
		case 'approve_with_edits':
			return 'approved';
		case 'deny':
			return 'denied';
		case 'remember':
			return 'remembered';
		case 'cancel':
			return 'cancelled';
		case 'expire':
			return 'expired';
	}
}

function toCardState(row: ApprovalRequestRow): ApprovalCardState {
	const proposedArguments = parseJson(row.proposedArgs);
	const editedArguments = parseJson(row.editedArgs);
	const canonicalArguments = parseJson(row.canonicalArgs) ?? proposedArguments;
	const resolution =
		row.status === 'pending'
			? undefined
			: ({
					approvalId: row.id,
					action:
						row.status === 'approved' && editedArguments !== undefined
							? 'approve_with_edits'
							: row.status === 'approved'
								? 'approve'
								: row.status === 'denied'
									? 'deny'
									: row.status === 'remembered'
										? 'remember'
										: row.status === 'cancelled'
											? 'cancel'
											: 'expire',
					terminalState: row.status,
					canonicalArguments,
					proposedArguments,
					...(editedArguments === undefined ? {} : { editedArguments }),
					...(row.reason ? { reason: row.reason } : {}),
					remember: row.remember,
					actor: row.status === 'expired' ? 'system' : 'user',
					resolvedAt: row.resolvedAt ?? row.updatedAt
				} satisfies ApprovalResolution);

	return {
		approvalId: row.id,
		sessionId: row.sessionId,
		runId: row.runId,
		toolCall: {
			id: row.toolCallId,
			name: row.toolName,
			arguments: proposedArguments
		},
		tool: toolsByName.get(row.toolName) ?? {
			name: row.toolName,
			description: row.toolName,
			inputSchema: {},
			metadata: {
				risk: 'high',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 0,
				retry: { maximumAttempts: 1 },
				idempotencyBehavior: 'key-required'
			}
		},
		policyVersion: row.policyVersion,
		proposedArguments,
		argsHash: row.argsHash,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		status: row.status,
		...(resolution ? { resolution } : {})
	};
}

export class ApprovalsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async recordRequest(input: RecordApprovalRequestInput): Promise<ApprovalCardState> {
		const existing = await this.findById(input.approvalId);
		if (existing) return existing;

		const createdAt = input.createdAt ?? new Date().toISOString();
		const argsHash = hashApprovalArguments(input.proposedArguments);
		const payload = {
			approvalId: input.approvalId,
			toolCall: input.toolCall,
			tool: input.tool,
			policyVersion: input.policyVersion,
			proposedArguments: input.proposedArguments,
			argsHash,
			expiresAt: input.expiresAt
		};

		await this.database.insert(approvalRequests).values({
			id: input.approvalId,
			sessionId: input.sessionId,
			runId: input.runId,
			toolCallId: input.toolCall.id,
			toolName: input.toolCall.name,
			status: 'pending',
			proposedArgs: JSON.stringify(input.proposedArguments),
			argsHash,
			policyVersion: input.policyVersion,
			expiresAt: input.expiresAt,
			createdAt,
			updatedAt: createdAt
		});

		await this.database.insert(auditEvents).values({
			id: `${input.approvalId}:request`,
			sessionId: input.sessionId,
			runId: input.runId,
			kind: 'approval_request',
			toolCallId: input.toolCall.id,
			argsHash,
			policyVersion: input.policyVersion,
			actor: 'system',
			payload: JSON.stringify(payload),
			createdAt
		});

		await appendTranscriptEvent(this.database, {
			id: `${input.approvalId}:request`,
			sessionId: input.sessionId,
			runId: input.runId,
			kind: 'approval_request',
			payload: JSON.stringify(payload),
			createdAt
		});

		await publishStreamEvent(this.database, {
			sessionId: input.sessionId,
			runId: input.runId,
			kind: 'approval.request',
			payload: JSON.stringify(payload),
			createdAt
		});

		await this.database
			.update(runs)
			.set({ status: 'waiting_approval', updatedAt: createdAt })
			.where(eq(runs.id, input.runId));

		const persisted = await this.findById(input.approvalId);
		if (!persisted) throw new Error(`Approval request was not persisted: ${input.approvalId}`);
		return persisted;
	}

	async recordResolution(input: RecordApprovalResolutionInput): Promise<ApprovalResolution> {
		const rows = await this.database
			.select()
			.from(approvalRequests)
			.where(eq(approvalRequests.id, input.approvalId))
			.limit(1);
		const row = rows[0];
		if (!row) throw new Error(`Unknown approval: ${input.approvalId}`);

		if (row.status !== 'pending') {
			const card = toCardState(row);
			if (!card.resolution) throw new Error(`Approval has no resolution: ${input.approvalId}`);
			return card.resolution;
		}

		const proposedArguments = JSON.parse(row.proposedArgs) as unknown;
		const editedArguments =
			input.action === 'approve_with_edits' ? input.editedArguments : undefined;
		const canonicalArguments =
			input.action === 'approve_with_edits' ? editedArguments : proposedArguments;
		const terminalState = terminalStateForAction(input.action);
		const resolvedAt = input.resolvedAt ?? new Date().toISOString();
		const remember = input.remember === true || input.action === 'remember';
		const resolution: ApprovalResolution = {
			approvalId: input.approvalId,
			action: input.action,
			terminalState,
			canonicalArguments,
			proposedArguments,
			...(editedArguments === undefined ? {} : { editedArguments }),
			...(input.reason ? { reason: input.reason } : {}),
			remember,
			actor: input.actor,
			resolvedAt
		};

		await this.database
			.update(approvalRequests)
			.set({
				status: terminalState,
				canonicalArgs: JSON.stringify(canonicalArguments),
				editedArgs: editedArguments === undefined ? null : JSON.stringify(editedArguments),
				reason: input.reason ?? null,
				remember,
				resolvedAt,
				updatedAt: resolvedAt
			})
			.where(eq(approvalRequests.id, input.approvalId));

		// When the grant is approved, restore runs.status to 'running' so consumers
		// (admin UI, monitoring, SSE route) see the active post-approval execution.
		// Deny, cancel, and expire are left to recordRunCompleted.
		if (terminalState === 'approved') {
			await this.database
				.update(runs)
				.set({ status: 'running', updatedAt: resolvedAt })
				.where(eq(runs.id, row.runId));
		}

		await this.database.insert(auditEvents).values({
			id: `${input.approvalId}:resolution:${terminalState}`,
			sessionId: row.sessionId,
			runId: row.runId,
			kind: 'approval_resolution',
			toolCallId: row.toolCallId,
			argsHash: row.argsHash,
			editedArgs: editedArguments === undefined ? null : JSON.stringify(editedArguments),
			policyVersion: row.policyVersion,
			actor: input.actor,
			payload: JSON.stringify(resolution),
			createdAt: resolvedAt
		});

		await appendTranscriptEvent(this.database, {
			id: `${input.approvalId}:resolution:${terminalState}`,
			sessionId: row.sessionId,
			runId: row.runId,
			kind: 'approval_resolution',
			payload: JSON.stringify(resolution),
			createdAt: resolvedAt
		});

		await publishStreamEvent(this.database, {
			sessionId: row.sessionId,
			runId: row.runId,
			kind: 'approval.resolution',
			payload: JSON.stringify(resolution),
			createdAt: resolvedAt
		});

		return resolution;
	}

	async findById(approvalId: string): Promise<ApprovalCardState | null> {
		const rows = await this.database
			.select()
			.from(approvalRequests)
			.where(eq(approvalRequests.id, approvalId))
			.limit(1);
		return rows[0] ? toCardState(rows[0]) : null;
	}

	/** List all approval requests for a session, pending first then newest first. */
	async listBySession(sessionId: string): Promise<ApprovalCardState[]> {
		const rows = await this.database
			.select()
			.from(approvalRequests)
			.where(eq(approvalRequests.sessionId, sessionId))
			.orderBy(asc(approvalRequests.status), desc(approvalRequests.createdAt));
		return rows.map(toCardState);
	}
}
