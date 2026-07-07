import { error, json } from '@sveltejs/kit';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import type { RequestHandler } from './$types';
import { TASK_QUEUE_ORCHESTRATOR, type SessionAttachmentInput } from '$lib/types';
import { getTemporalClient } from '$lib/server/temporal/client';
import { getSandboxProvider } from '$lib/server/sandbox';
import { agentSessionWorkflow } from '@src/workflows/agent-session.workflow';
import { submitTurnUpdate } from '@src/workflows/session-contracts';
import { isValidSessionKey } from '$lib/server/session-key';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_KINDS = new Set(['image', 'code', 'document']);

/**
 * Validates and normalizes the `attachments` field of a turn submission.
 * Throws a 400 SvelteKit error for any malformed or over-limit entry — the
 * boundary that owns this contract, so bad input never reaches the sandbox
 * write or the workflow.
 */
function parseAttachments(raw: unknown): SessionAttachmentInput[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw error(400, 'attachments must be an array');
	if (raw.length > MAX_ATTACHMENTS) {
		throw error(400, `attachments must not exceed ${MAX_ATTACHMENTS} files`);
	}

	return raw.map((entry): SessionAttachmentInput => {
		const record = entry as Record<string, unknown>;
		if (typeof record?.name !== 'string' || !record.name.trim()) {
			throw error(400, 'each attachment requires a non-empty name');
		}
		if (typeof record.mimeType !== 'string' || !record.mimeType) {
			throw error(400, 'each attachment requires a mimeType');
		}
		if (typeof record.kind !== 'string' || !ATTACHMENT_KINDS.has(record.kind)) {
			throw error(400, 'each attachment requires a valid kind (image, code, or document)');
		}
		if (typeof record.content !== 'string' || !record.content) {
			throw error(400, 'each attachment requires base64 content');
		}
		const decodedBytes = Buffer.from(record.content, 'base64').length;
		if (decodedBytes > MAX_ATTACHMENT_BYTES) {
			throw error(400, `attachment "${record.name}" exceeds the 10MB limit`);
		}

		return {
			name: record.name,
			mimeType: record.mimeType,
			kind: record.kind as SessionAttachmentInput['kind'],
			content: record.content
		};
	});
}

/** A filename made safe for a workspace-relative path — strips separators and traversal. */
function sanitizeAttachmentName(name: string): string {
	return name.replace(/[/\\]/g, '_').replace(/^\.+/, '');
}

export const POST: RequestHandler = async ({ params, request }) => {
	const { sessionKey } = params;

	if (!isValidSessionKey(sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}

	const body = await request.json().catch(() => null);
	const message = typeof body?.message === 'string' ? body.message.trim() : '';
	const attachments = parseAttachments(body?.attachments);
	if (!message && attachments.length === 0) {
		throw error(400, 'message is required');
	}
	const delegateSubagents = body?.delegateSubagents === true ? true : undefined;
	const model = typeof body?.model === 'string' && body.model ? body.model : undefined;
	const maxBudgetUsd = typeof body?.maxBudgetUsd === 'number' ? body.maxBudgetUsd : undefined;

	const workflowId = `agent-session:${sessionKey}`;

	try {
		// Write attachments into the session's sandbox workspace before the turn
		// starts so the agent can `workspace.readFile` them immediately — the
		// local-subprocess sandbox is single-host, so the worker process resolves
		// the same `~/.stardust/workspaces/<sessionKey>` directory this write uses.
		if (attachments.length > 0) {
			const sandboxProvider = getSandboxProvider();
			await Promise.all(
				attachments.map((attachment) =>
					sandboxProvider.writeFile({
						sessionKey,
						path: `attachments/${sanitizeAttachmentName(attachment.name)}`,
						contents: attachment.content,
						encoding: 'base64'
					})
				)
			);
		}

		const attachmentNote =
			attachments.length > 0
				? `\n\n[Attached file(s) — read via workspace tools: ${attachments
						.map((attachment) => `attachments/${sanitizeAttachmentName(attachment.name)}`)
						.join(', ')}]`
				: '';
		const finalMessage = `${message || '(See attached file(s).)'}${attachmentNote}`;

		const client = await getTemporalClient();

		// Start-or-use-existing in one call, then send the update.
		await client.workflow.start(agentSessionWorkflow, {
			workflowId,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
			args: [{ sessionKey }]
		});

		const handle = client.workflow.getHandle(workflowId);
		const result = await handle.executeUpdate(submitTurnUpdate, {
			args: [{ message: finalMessage, delegateSubagents, model, maxBudgetUsd }]
		});

		return json({
			accepted: result.accepted,
			runId: result.runId,
			streamUrl: `/api/sessions/${sessionKey}/stream/${result.runId}`
		});
	} catch (caught) {
		// Surface the real reason (misconfiguration, unreachable Temporal, unknown
		// namespace) instead of a bare 500 — the client renders this message directly.
		const reason =
			caught instanceof Error ? caught.message : 'Failed to reach the session service.';
		throw error(503, reason);
	}
};
