import type {
	ApprovalCardState,
	ApprovalResolution,
	ApprovalResolutionInput,
	RecordApprovalRequestInput,
	RecordApprovalResolutionInput,
	ToolCallInput,
	ToolManifestEntry,
	ToolPolicyDecision
} from '@src/lib/types';
import { getConfiguredTools, getToolManifest } from '../lib/server/tools/registry';
import { validateToolCall } from '../lib/server/policy/policy-engine';
import { db } from '../lib/server/db/client';
import { ApprovalsRepository } from '../lib/server/policy/approvals';
import { getTemporalClient } from '../lib/server/temporal/client';
import { resolveApprovalUpdate } from '@src/workflows/approval-contracts';
import { isMacOs, sendUserNotification } from '../lib/server/tools/local-notifications';

export async function listToolManifest(input?: {
	allowedToolNames?: string[];
}): Promise<ToolManifestEntry[]> {
	return getToolManifest(input);
}

export async function evaluateToolCallPolicy(input: {
	call: ToolCallInput;
}): Promise<ToolPolicyDecision> {
	return validateToolCall(getConfiguredTools(), input.call);
}

export async function recordApprovalRequest(
	input: RecordApprovalRequestInput
): Promise<ApprovalCardState> {
	const approvals = new ApprovalsRepository(db);
	// `recordRequest` is idempotent — a retried/replayed call with the same
	// `approvalId` short-circuits to the already-persisted row without writing
	// anything new. Check for that row first so a retry doesn't fire a duplicate
	// "needs approval" notification for an approval the user was already told about.
	const alreadyRecorded = await approvals.findById(input.approvalId);
	const approval = await approvals.recordRequest(input);
	if (!alreadyRecorded) await notifyApprovalPending(approval);
	return approval;
}

/**
 * Fires a native desktop notification when a run blocks on approval, so the user
 * notices even when Stardust isn't in the foreground. Local-only and best-effort:
 * it never runs off-macOS, and any failure (no `osascript`, notification denied,
 * etc.) is swallowed — a notification failure must never fail approval recording.
 */
async function notifyApprovalPending(approval: ApprovalCardState): Promise<void> {
	if (!isMacOs()) return;
	try {
		await sendUserNotification({
			title: 'Stardust needs approval',
			message: `${approval.toolCall.name} is waiting for your approval`
		});
	} catch {
		// Swallowed intentionally — see doc comment above.
	}
}

export async function recordApprovalResolution(
	input: RecordApprovalResolutionInput
): Promise<ApprovalResolution> {
	return new ApprovalsRepository(db).recordResolution(input);
}

/**
 * Forwards an approval resolution from the session workflow to the active run workflow.
 *
 * The session cannot call `executeUpdate` directly (only `signal`/`cancel` are available
 * on `getExternalWorkflowHandle`), so it delegates to this activity, which uses the
 * Temporal client — the same pattern as `submitScheduledTurn`.
 */
export async function forwardApprovalToRun(input: {
	runId: string;
	resolution: ApprovalResolutionInput;
}): Promise<ApprovalResolution> {
	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(`agent-run:${input.runId}`);
	return handle.executeUpdate(resolveApprovalUpdate, { args: [input.resolution] });
}
