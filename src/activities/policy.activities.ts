import type {
	ApprovalCardState,
	ApprovalResolution,
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
