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
import { registeredTools, getToolManifest } from '../lib/server/tools/registry';
import { validateToolCall } from '../lib/server/policy/policy-engine';
import { db } from '../lib/server/db/client';
import { ApprovalsRepository } from '../lib/server/policy/approvals';
import { getTemporalClient } from '../lib/server/temporal/client';
import { resolveApprovalUpdate } from '@src/workflows/approval-contracts';

export async function listToolManifest(input?: {
	allowedToolNames?: string[];
}): Promise<ToolManifestEntry[]> {
	return getToolManifest(input);
}

export async function evaluateToolCallPolicy(input: {
	call: ToolCallInput;
}): Promise<ToolPolicyDecision> {
	return validateToolCall(registeredTools, input.call);
}

export async function recordApprovalRequest(
	input: RecordApprovalRequestInput
): Promise<ApprovalCardState> {
	return new ApprovalsRepository(db).recordRequest(input);
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
