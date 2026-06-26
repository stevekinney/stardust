import { error, json } from '@sveltejs/kit';
import type { ApprovalResolutionInput } from '$lib/types';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { ApprovalsRepository } from '$lib/server/policy/approvals';
import { getTemporalClient } from '$lib/server/temporal/client';
import { resolveApprovalUpdate } from '@src/workflows/approval-contracts';

const APPROVAL_ACTIONS = new Set(['approve', 'approve_with_edits', 'deny', 'remember', 'cancel']);

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => null);
	const action = typeof body?.action === 'string' ? body.action : '';
	if (!APPROVAL_ACTIONS.has(action)) {
		throw error(400, 'action is required');
	}

	const repository = new ApprovalsRepository(db);
	const approval = await repository.findById(params.approvalId);
	if (!approval) {
		throw error(404, 'approval not found');
	}

	const resolutionInput: ApprovalResolutionInput = {
		approvalId: params.approvalId,
		action: action as ApprovalResolutionInput['action'],
		...(body?.editedArguments === undefined ? {} : { editedArguments: body.editedArguments }),
		...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
		...(typeof body?.remember === 'boolean' ? { remember: body.remember } : {}),
		actor: 'user'
	};

	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(`agent-run:${approval.runId}`);
	const resolution = await handle.executeUpdate(resolveApprovalUpdate, {
		args: [resolutionInput]
	});

	return json({ approvalId: params.approvalId, resolution });
};
