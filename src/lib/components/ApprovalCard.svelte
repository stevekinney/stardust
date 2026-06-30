<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Textarea from '@lostgradient/cinder/textarea';
	import type { ApprovalCardState, ApprovalResolutionInput } from '$lib/types';

	type Props = {
		approval: ApprovalCardState;
		resolveEndpoint?: string;
		onResolve?: (resolution: ApprovalResolutionInput) => void | Promise<void>;
	};

	let { approval, resolveEndpoint, onResolve }: Props = $props();

	let editedArgumentsOverride = $state<{ approvalId: string; text: string } | null>(null);
	let reason = $state('');
	let remember = $state(false);
	let errorMessage = $state('');
	let isResolving = $state(false);

	const isPending = $derived(approval.status === 'pending');
	const expiryText = $derived(new Date(approval.expiresAt).toLocaleString());
	const editedArgumentsText = $derived(
		editedArgumentsOverride?.approvalId === approval.approvalId
			? editedArgumentsOverride.text
			: JSON.stringify(approval.proposedArguments, null, 2)
	);

	function createResolution(action: ApprovalResolutionInput['action']): ApprovalResolutionInput {
		errorMessage = '';
		const resolution: ApprovalResolutionInput = {
			approvalId: approval.approvalId,
			action,
			remember,
			actor: 'user'
		};

		if (reason.trim()) {
			resolution.reason = reason.trim();
		}

		if (action === 'approve_with_edits') {
			try {
				resolution.editedArguments = JSON.parse(editedArgumentsText);
			} catch {
				errorMessage = 'Edited arguments must be valid JSON.';
			}
		}

		return resolution;
	}

	async function resolve(action: ApprovalResolutionInput['action']) {
		const resolution = createResolution(action);
		if (errorMessage) return;

		isResolving = true;
		try {
			if (onResolve) {
				await onResolve(resolution);
			} else {
				const response = await fetch(
					resolveEndpoint ?? `/api/approvals/${approval.approvalId}/resolve`,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(resolution)
					}
				);
				if (!response.ok) {
					throw new Error(await response.text());
				}
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			isResolving = false;
		}
	}

	function updateEditedArguments(event: Event) {
		editedArgumentsOverride = {
			approvalId: approval.approvalId,
			text: (event.currentTarget as HTMLTextAreaElement).value
		};
	}
</script>

<article class="approval-card" data-status={approval.status} aria-labelledby="approval-card-title">
	<header class="approval-header">
		<div>
			<p class="eyebrow">Approval required</p>
			<h2 id="approval-card-title">{approval.tool.name}</h2>
			{#if approval.tool.description && approval.tool.description !== approval.tool.name}
				<p class="tool-description">{approval.tool.description}</p>
			{/if}
		</div>
		<span class="status">{approval.status}</span>
	</header>

	<!-- Raw <dl> preserved: DescriptionList only supports plain string definitions;
	     metadata uses <code> elements and conditional sub-items that require HTML. -->
	<dl class="metadata">
		<div>
			<dt>Expires</dt>
			<dd>{expiryText}</dd>
		</div>
		<div>
			<dt>Risk</dt>
			<dd>{approval.tool.metadata.risk}</dd>
		</div>
		<div>
			<dt>Policy version</dt>
			<dd>{approval.policyVersion}</dd>
		</div>
		<div>
			<dt>Arguments hash</dt>
			<dd>{approval.argsHash}</dd>
		</div>
		{#if approval.toolCall.idempotencyKey}
			<div>
				<dt>Idempotency key</dt>
				<dd>{approval.toolCall.idempotencyKey}</dd>
			</div>
		{/if}
		{#if approval.workingDirectory}
			<div>
				<dt>Working directory</dt>
				<dd>{approval.workingDirectory}</dd>
			</div>
		{/if}
		{#if approval.environmentVariableNames && approval.environmentVariableNames.length > 0}
			<div>
				<dt>Environment variables</dt>
				<dd>{approval.environmentVariableNames.join(', ')}</dd>
			</div>
		{/if}
		{#if approval.snapshotReferences && approval.snapshotReferences.length > 0}
			<div>
				<dt>Snapshot references</dt>
				<dd>{approval.snapshotReferences.join(', ')}</dd>
			</div>
		{/if}
	</dl>

	<section class="arguments" aria-label="Approval arguments">
		<div>
			<h3>Proposed arguments</h3>
			<pre>{JSON.stringify(approval.proposedArguments, null, 2)}</pre>
		</div>
		<label>
			<span>Edited arguments</span>
			<Textarea
				id="approval-edited-args-{approval.approvalId}"
				value={editedArgumentsText}
				disabled={!isPending}
				oninput={updateEditedArguments}
				rows={8}
			/>
		</label>
	</section>

	{#if approval.diff}
		<section class="diff" aria-label="Proposed diff">
			<h3>Diff</h3>
			<pre>{approval.diff}</pre>
		</section>
	{/if}

	<label class="reason">
		<span>Reason</span>
		<Textarea
			id="approval-reason-{approval.approvalId}"
			bind:value={reason}
			disabled={!isPending}
			rows={3}
		/>
	</label>

	<!-- Raw <input type="checkbox"> preserved: Cinder has no Checkbox component. -->
	<label class="remember">
		<input type="checkbox" bind:checked={remember} disabled={!isPending} />
		<span>Remember this approval boundary</span>
	</label>

	{#if errorMessage}
		<p class="error" role="alert">{errorMessage}</p>
	{/if}

	<footer class="actions">
		<Button
			label="Approve"
			variant="primary"
			disabled={!isPending || isResolving}
			onclick={() => resolve('approve')}
		/>
		<Button
			label="Approve with edits"
			variant="secondary"
			disabled={!isPending || isResolving}
			onclick={() => resolve('approve_with_edits')}
		/>
		<Button
			label="Deny"
			variant="danger"
			disabled={!isPending || isResolving}
			onclick={() => resolve('deny')}
		/>
		<Button
			label="Remember"
			variant="secondary"
			disabled={!isPending || isResolving}
			onclick={() => resolve('remember')}
		/>
		<Button
			label="Cancel run"
			variant="ghost-danger"
			disabled={!isPending || isResolving}
			onclick={() => resolve('cancel')}
		/>
	</footer>
</article>

<style>
	.approval-card {
		display: grid;
		gap: 1rem;
		max-width: 56rem;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
		border-radius: 8px;
		background: Canvas;
		color: CanvasText;
	}

	.approval-header,
	.actions,
	.metadata {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	.approval-header {
		justify-content: space-between;
	}

	.eyebrow,
	dt {
		margin: 0;
		color: color-mix(in srgb, CanvasText 60%, transparent);
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	h2,
	h3,
	dd {
		margin: 0;
	}

	h2 {
		font-size: 1.125rem;
	}

	h3,
	label span {
		font-size: 0.875rem;
		font-weight: 650;
	}

	.status {
		padding: 0.25rem 0.5rem;
		border-radius: 999px;
		background: color-mix(in srgb, CanvasText 10%, transparent);
		font-size: 0.75rem;
		font-weight: 650;
	}

	.metadata div {
		min-width: min(14rem, 100%);
	}

	.metadata dd {
		overflow-wrap: anywhere;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.8125rem;
	}

	.arguments {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr));
		gap: 1rem;
	}

	pre {
		box-sizing: border-box;
		width: 100%;
		min-height: 12rem;
		margin: 0.35rem 0 0;
		padding: 0.75rem;
		border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, CanvasText 4%, Canvas);
		color: inherit;
		font:
			0.8125rem/1.45 ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			monospace;
		overflow: auto;
	}

	.remember {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.error {
		margin: 0;
		color: #b42318;
		font-weight: 650;
	}
</style>
