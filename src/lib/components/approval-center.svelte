<script lang="ts" module>
	import type {
		ApprovalCardProps,
		ApprovalOperation,
		ApprovalResolution,
		ApprovalState
	} from '@lostgradient/cinder/approval-card';
	import type { ApprovalCardState, ApprovalResolutionInput } from '$lib/types';

	export function toCinderApprovalOperation(approval: ApprovalCardState): ApprovalOperation {
		const argsPreview = approval.proposedArguments;
		if (approval.diff) {
			return {
				kind: 'patch',
				diff: approval.diff,
				argsPreview
			};
		}
		const proposedArguments = approval.proposedArguments;
		if (typeof proposedArguments === 'object' && proposedArguments !== null) {
			const record = proposedArguments as Record<string, unknown>;
			if (typeof record.command === 'string') {
				return { kind: 'command', command: record.command, argsPreview };
			}
			if (typeof record.cmd === 'string') {
				return { kind: 'command', command: record.cmd, argsPreview };
			}
			if (typeof record.path === 'string') {
				return { kind: 'file-write', filesTouched: [record.path], argsPreview };
			}
		}
		return { kind: 'other', argsPreview };
	}

	function toCinderApprovalState(status: ApprovalCardState['status']): ApprovalState {
		if (status === 'approved') return 'approved';
		if (status === 'remembered') return 'approved';
		if (status === 'denied') return 'denied';
		if (status === 'cancelled') return 'cancelled';
		if (status === 'expired') return 'expired';
		return 'pending';
	}

	function toStardustApprovalResolution(
		approvalId: string,
		resolution: ApprovalResolution
	): ApprovalResolutionInput {
		const action =
			resolution.decision === 'approve_with_edits'
				? 'approve_with_edits'
				: resolution.decision === 'deny'
					? 'deny'
					: resolution.decision === 'cancel'
						? 'cancel'
						: 'approve';

		return {
			approvalId,
			action,
			editedArguments: resolution.editedArgs,
			reason: resolution.reason,
			remember: resolution.remember,
			actor: 'user'
		};
	}

	function toCinderApprovalProps(
		approval: ApprovalCardState,
		onResolve?: (resolution: ApprovalResolutionInput) => void | Promise<void>
	): ApprovalCardProps {
		return {
			tool: {
				name: approval.tool.name,
				risk: approval.tool.metadata.risk
			},
			operation: toCinderApprovalOperation(approval),
			env: approval.environmentVariableNames,
			sandbox: approval.workingDirectory
				? {
						provider: 'local',
						name: 'Stardust workspace',
						workingDir: approval.workingDirectory
					}
				: undefined,
			snapshotId: approval.snapshotReferences?.join(', '),
			policyVersion: approval.policyVersion,
			idempotencyKey: approval.toolCall.idempotencyKey ?? approval.approvalId,
			expiresAt: approval.expiresAt,
			state: toCinderApprovalState(approval.status),
			editableArgs: approval.status === 'pending',
			onresolve: (resolution) =>
				void onResolve?.(toStardustApprovalResolution(approval.approvalId, resolution))
		};
	}
</script>

<script lang="ts">
	import CinderApprovalCard from '@lostgradient/cinder/approval-card';
	import EmptyState from '@lostgradient/cinder/empty-state';
	import type {
		ApprovalCardState as StardustApprovalCardState,
		ApprovalResolutionInput as StardustApprovalResolutionInput
	} from '$lib/types';

	type Props = {
		approvals: StardustApprovalCardState[];
		onResolve?: (resolution: StardustApprovalResolutionInput) => void | Promise<void>;
	};

	let { approvals, onResolve }: Props = $props();

	const isEmpty = $derived(approvals.length === 0);
</script>

<section class="approval-center" aria-labelledby="approval-center-heading">
	<h2 id="approval-center-heading">Approval Center</h2>

	{#if isEmpty}
		<EmptyState
			title="No pending approvals"
			description="No pending approvals for this run."
			headingLevel={3}
		/>
	{:else}
		<div class="approval-list">
			{#each approvals as approval (approval.approvalId)}
				<CinderApprovalCard {...toCinderApprovalProps(approval, onResolve)} />
			{/each}
		</div>
	{/if}
</section>

<style>
	.approval-center {
		display: grid;
		gap: 1rem;
	}

	h2 {
		margin: 0 0 0.25rem;
	}

	.approval-list {
		display: grid;
		gap: 1rem;
	}
</style>
