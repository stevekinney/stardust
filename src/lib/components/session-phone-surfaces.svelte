<script lang="ts">
	import Badge from '@lostgradient/cinder/badge';
	import Button from '@lostgradient/cinder/button';
	import { toApprovalOperation } from './conversation-view.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import type { PendingApprovalEntry } from '$lib/types';

	type Props = {
		sessionKey: string;
		currentUserMessage: string | null;
		inspector: RunInspectorProjection | null;
		running: boolean;
		pendingApproval: PendingApprovalEntry | null;
		onResolveApproval: (approvalId: string, action: 'approve' | 'deny') => void;
	};

	let {
		sessionKey,
		currentUserMessage,
		inspector,
		running,
		pendingApproval,
		onResolveApproval
	}: Props = $props();

	/** Durable event id for the phone monitor 3-col ribbon, derived from inspector run. */
	const phoneDurableEventId = $derived.by(() => {
		const cursor = inspector?.durabilityEvidence.latestTranscriptSequence;
		return cursor == null ? '—' : String(cursor);
	});

	/** Extracts the first tool name from a tool_call payload for phone step labels. */
	function extractToolCallLabel(payload: unknown): string {
		if (typeof payload !== 'object' || payload === null) return 'Tool call';
		const p = payload as Record<string, unknown>;
		if (!Array.isArray(p.calls) || p.calls.length === 0) return 'Tool call';
		const first = p.calls[0] as Record<string, unknown>;
		return typeof first.name === 'string' ? first.name : 'Tool call';
	}

	type PhoneStep = {
		id: string;
		label: string;
		status: 'complete' | 'running' | 'pending';
		durationLabel: string | null;
	};

	/** Tool-call steps from the inspector transcript for the phone monitor view. */
	const phoneSteps = $derived.by((): PhoneStep[] => {
		if (!inspector) return [];
		const toolCalls = inspector.transcript.filter((e) => e.kind === 'tool_call');
		return toolCalls.map((e, i) => {
			const label = extractToolCallLabel(e.payload);
			const isLast = i === toolCalls.length - 1;
			const isComplete = e.durationMs !== undefined;
			const status: 'complete' | 'running' | 'pending' = isComplete
				? 'complete'
				: running && isLast
					? 'running'
					: 'pending';
			const durationLabel =
				e.durationMs != null
					? e.durationMs < 1000
						? `${e.durationMs}ms`
						: `${(e.durationMs / 1000).toFixed(1)}s`
					: null;
			return { id: e.id, label, status, durationLabel };
		});
	});

	/** Extracts environment variable names from a tool call's arguments (names only — no values). */
	function getToolEnvVars(toolCall: { arguments: unknown }): string[] {
		const args = toolCall.arguments;
		if (typeof args !== 'object' || args === null) return [];
		const obj = args as Record<string, unknown>;
		if (Array.isArray(obj.env)) return obj.env.filter((e): e is string => typeof e === 'string');
		if (typeof obj.environment === 'object' && obj.environment !== null) {
			return Object.keys(obj.environment as Record<string, unknown>);
		}
		return [];
	}

	/** Formats remaining time from an ISO expiry timestamp (static at render — no live ticker). */
	function formatExpiresIn(isoString: string): string {
		const remaining = Math.max(0, Math.floor((new Date(isoString).getTime() - Date.now()) / 1000));
		return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
	}
</script>

{#if pendingApproval === null}
	<div class="phone-monitor">
		<div class="phone-session-hd">
			<div class="phone-session-name">{currentUserMessage?.slice(0, 40) ?? sessionKey}</div>
			<div class="phone-session-meta">
				{sessionKey} · {inspector?.run.status ?? (running ? 'running' : 'idle')} · step {phoneSteps.length}
			</div>
		</div>

		<div class="phone-ribbon-3">
			<div class="p3rib">
				<span class="p3rib-n">{inspector?.durabilityEvidence.streamGapCount ?? '—'}</span>
				<span class="p3rib-l">reconnects</span>
			</div>
			<div class="p3rib">
				<span class="p3rib-n p3rib-success"
					>{inspector?.durabilityEvidence.retryAttemptCount ?? '—'}</span
				>
				<span class="p3rib-l">auto-retry</span>
			</div>
			<div class="p3rib">
				<span class="p3rib-n p3rib-accent">{phoneDurableEventId}</span>
				<span class="p3rib-l">durable</span>
			</div>
		</div>

		<div class="phone-steps-list">
			{#if phoneSteps.length > 0}
				{#each phoneSteps as step (step.id)}
					<div class="phone-step" class:phone-step-dim={step.status === 'pending'}>
						<span
							class="phone-step-dot"
							class:dot-success={step.status === 'complete'}
							class:dot-info={step.status === 'running'}
							class:dot-pulse={step.status === 'running'}
							class:dot-muted={step.status === 'pending'}
						></span>
						<span class="phone-step-label" class:phone-step-active={step.status === 'running'}
							>{step.label}</span
						>
						{#if step.durationLabel}
							<span class="phone-step-dur">{step.durationLabel}</span>
						{/if}
					</div>
				{/each}
			{:else if running}
				<div class="phone-step">
					<span class="phone-step-dot dot-info dot-pulse"></span>
					<span class="phone-step-label phone-step-active">Starting…</span>
				</div>
			{:else}
				<div class="phone-step">
					<span class="phone-step-dot dot-muted"></span>
					<span class="phone-step-label">No steps yet</span>
				</div>
			{/if}
		</div>

		<div class="phone-nudge">
			<!-- lucide monitor -->
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<rect x="2" y="3" width="20" height="14" rx="2" />
				<path d="M8 21h8" />
				<path d="M12 17v4" />
			</svg>
			Open on desktop to steer or interrupt
		</div>
	</div>
{:else}
	{@const phoneApproval = pendingApproval}
	{@const phoneApprovalOp = toApprovalOperation(phoneApproval.toolCall)}
	{@const phoneEnvVars = getToolEnvVars(phoneApproval.toolCall)}
	<div class="phone-approval-surface">
		<div class="phone-approval-hd">
			<div class="phone-approval-hd-row">
				<!-- lucide shield-alert -->
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
					/>
					<path d="M12 8v4" />
					<path d="M12 16h.01" />
				</svg>
				<span class="phone-approval-title">Approval required</span>
				<span class="spacer"></span>
				<Badge variant="danger" size="sm">High risk</Badge>
			</div>
			<div class="phone-approval-tool">{phoneApproval.toolCall.name}</div>
			<div class="phone-approval-expiry">
				expires in {formatExpiresIn(phoneApproval.expiresAt)} · {phoneApproval.sessionId.slice(
					0,
					8
				)}
			</div>
		</div>

		<div class="phone-approval-body">
			<div class="phone-approval-section">
				<div class="phone-approval-label">Command</div>
				<div class="phone-approval-cmd">
					{#if phoneApprovalOp.kind === 'command'}
						{phoneApprovalOp.command}
					{:else}
						{JSON.stringify(phoneApprovalOp.argsPreview)}
					{/if}
				</div>
			</div>
			<div class="phone-approval-meta-row">
				<div class="phone-approval-meta-item">
					<div class="phone-approval-label">Files</div>
					<div class="phone-approval-meta-val">1 touched</div>
				</div>
				<div class="phone-approval-meta-item">
					<div class="phone-approval-label">Sandbox</div>
					<div class="phone-approval-meta-val phone-mono">
						{phoneApproval.sessionId.slice(0, 8)}
					</div>
				</div>
			</div>
			{#if phoneEnvVars.length > 0}
				<div class="phone-approval-section">
					<div class="phone-approval-label">Environment · names only</div>
					<div class="phone-env-chips">
						{#each phoneEnvVars as envVar (envVar)}
							<span class="phone-env-chip">{envVar}</span>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<div class="phone-approval-actions">
			<Button
				variant="primary"
				fullWidth
				onclick={() => onResolveApproval(phoneApproval.approvalId, 'approve')}
			>
				Approve
			</Button>
			<div class="phone-approval-secondary">
				<Button
					variant="soft-danger"
					fullWidth
					onclick={() => onResolveApproval(phoneApproval.approvalId, 'deny')}
				>
					Deny
				</Button>
				<Button
					variant="soft"
					fullWidth
					onclick={() => onResolveApproval(phoneApproval.approvalId, 'approve')}
				>
					Remember
				</Button>
			</div>
			<p class="phone-approval-note">Editing arguments opens on desktop</p>
		</div>
	</div>
{/if}

<style>
	/* Phone surfaces — hidden by default, shown on ≤640px. */

	.phone-monitor,
	.phone-approval-surface {
		display: none;
	}

	@media (max-width: 640px) {
		.phone-monitor,
		.phone-approval-surface {
			display: flex;
			flex-direction: column;
			flex: 1;
			overflow-y: auto;
			min-height: 0;
		}
	}

	.spacer {
		flex: 1;
	}

	.phone-session-hd {
		padding: 10px 16px 12px;
		border-bottom: 1px solid var(--cinder-border);
		flex: none;
	}

	.phone-session-name {
		font: 650 16px system-ui;
		color: var(--cinder-text);
	}

	.phone-session-meta {
		font: 500 10.5px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 2px;
	}

	.phone-ribbon-3 {
		display: flex;
		flex: none;
		border-bottom: 1px solid var(--cinder-border);
	}

	.p3rib {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 10px 8px;
		text-align: center;
	}

	.p3rib + .p3rib {
		border-left: 1px solid var(--cinder-border-muted);
	}

	.p3rib-n {
		font: 700 16px var(--cinder-font-mono);
		color: var(--cinder-text);
	}

	.p3rib-success {
		color: var(--cinder-success);
	}

	.p3rib-accent {
		color: var(--cinder-accent-text, var(--cinder-accent));
	}

	.p3rib-l {
		font: 400 9.5px system-ui;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.phone-steps-list {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 13px;
		flex: 1;
	}

	.phone-step {
		display: flex;
		align-items: center;
		gap: 9px;
	}

	.phone-step-dim {
		opacity: 0.55;
	}

	.phone-step-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-success {
		background: var(--cinder-success);
	}

	.dot-info {
		background: var(--cinder-info);
	}

	.dot-muted {
		background: var(--cinder-text-disabled);
	}

	.dot-pulse {
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	.phone-step-label {
		font: 500 12.5px system-ui;
		color: var(--cinder-text);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.phone-step-active {
		font-weight: 600;
	}

	.phone-step-dur {
		font: 500 10px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}

	.phone-nudge {
		margin: auto 16px 16px;
		border: 1px dashed var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		padding: 11px;
		text-align: center;
		font: 400 11px/1.5 system-ui;
		color: var(--cinder-text-subtle);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		flex: none;
	}

	.phone-approval-hd {
		padding: 10px 16px 12px;
		border-bottom: 1px solid var(--cinder-color-warning-border);
		background: var(--cinder-color-warning-bg);
		flex: none;
	}

	.phone-approval-hd-row {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--cinder-color-warning-fg);
	}

	.phone-approval-title {
		font: 600 11.5px system-ui;
		color: var(--cinder-color-warning-fg);
	}

	.phone-approval-tool {
		font: 650 15px system-ui;
		color: var(--cinder-text);
		margin-top: 9px;
	}

	.phone-approval-expiry {
		font: 500 10.5px var(--cinder-font-mono);
		color: var(--cinder-color-warning-fg);
		margin-top: 3px;
	}

	.phone-approval-body {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
		overflow-y: auto;
	}

	.phone-approval-section {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.phone-approval-label {
		font: 600 9.5px system-ui;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cinder-text-subtle);
	}

	.phone-approval-cmd {
		font: 500 11px/1.5 var(--cinder-font-mono);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-md);
		padding: 9px;
		word-break: break-all;
		white-space: pre-wrap;
	}

	.phone-approval-meta-row {
		display: flex;
		gap: 10px;
	}

	.phone-approval-meta-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.phone-approval-meta-val {
		font: 500 11px system-ui;
		color: var(--cinder-text);
	}

	.phone-mono {
		font-family: var(--cinder-font-mono);
	}

	.phone-env-chips {
		display: flex;
		gap: 5px;
		flex-wrap: wrap;
	}

	.phone-env-chip {
		font: 500 9px var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		padding: 3px 8px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
	}

	.phone-approval-actions {
		padding: 0 16px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex: none;
	}

	.phone-approval-secondary {
		display: flex;
		gap: 8px;
	}

	.phone-approval-note {
		text-align: center;
		font: 400 10px system-ui;
		color: var(--cinder-text-subtle);
		margin: 2px 0 0;
	}
</style>
