<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import ConversationView from '$lib/components/conversation-view.svelte';
	import type { StreamEvent } from '$lib/stream-to-conversation';
	import DurabilityRibbon from '$lib/components/durability-ribbon.svelte';
	import RunTimeline from '$lib/components/run-timeline.svelte';
	import RecoveryView from '$lib/components/recovery-view.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import { viewMode } from '$lib/view-mode.svelte';
	import type { PageData } from './$types';
	import ApprovalCard from '@lostgradient/cinder/approval-card';
	import type { ApprovalOperation } from '@lostgradient/cinder/approval-card';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import Segment from '@lostgradient/cinder/segment';
	import Badge from '@lostgradient/cinder/badge';

	let { data }: { data: PageData } = $props();

	const sessionKey = $derived(data.sessionKey);

	let running = $state(false);
	let liveEvents = $state<StreamEvent[]>([]);
	let canonicalEvents = $state<StreamEvent[]>([]);
	let transcriptMode = $state<'live' | 'canonical'>('live');
	let events = $derived(transcriptMode === 'live' ? liveEvents : canonicalEvents);
	let currentUserMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let streamGapNotice = $state<string | null>(null);
	let inspector = $state.raw<RunInspectorProjection | null>(null);
	let inspectorOpen = $state(true);

	type PendingApprovalEntry = {
		approvalId: string;
		sessionId: string;
		toolCall: { id: string; name: string; arguments: unknown };
		status: 'pending';
		createdAt: string;
		expiresAt: string;
	};

	let pendingApproval = $state<PendingApprovalEntry | null>(null);
	let approvalSlideOverOpen = $state(false);

	const isRecovered = $derived(inspector?.run.status === 'recovered');

	let abortController: AbortController | null = null;

	const demoPrompts = [
		{
			label: 'Verify change',
			message: 'Run verification for the current change and summarize failures.'
		},
		{
			label: 'Inspect UI',
			message: 'Inspect the local app UI in the browser and capture evidence.'
		},
		{
			label: 'Triage workflow',
			message:
				'Use Temporal MCP to triage the latest workflow and summarize durable execution state.'
		},
		{
			label: 'Workspace diff',
			message: 'Compare the current workspace diff and explain the risk.'
		},
		{ label: 'Create report', message: 'Create a run report artifact with the important evidence.' }
	];

	/** Controls which pane is active on tablet (641–1024px). */
	let tabletView = $state<'conversation' | 'run'>('conversation');

	onMount(() => {
		void loadPendingApproval();
		if (data.startMessage) {
			void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`), { replaceState: true });
			void handleSubmit(data.startMessage);
		} else {
			void loadTranscript().then(() => loadLatestRunInspector());
		}
	});

	async function loadTranscript() {
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/transcript`);
			if (!response.ok) return;

			const body = (await response.json()) as {
				events: Array<{ id: string; kind: string; payload: string; sequence: number }>;
			};

			const userMsgEvents = body.events.filter((e) => e.kind === 'user_message');
			if (userMsgEvents.length > 0) {
				const lastUserMsg = userMsgEvents[userMsgEvents.length - 1];
				try {
					const parsed = JSON.parse(lastUserMsg.payload) as { text?: string };
					currentUserMessage = parsed.text ?? null;
				} catch {
					// ignore malformed payload
				}
			}

			const KIND_MAP: Record<string, string> = {
				assistant_message: 'assistant.message',
				tool_result: 'tool.result',
				approval_request: 'approval.request',
				approval_resolution: 'approval.resolution',
				lifecycle: 'lifecycle'
			};

			let seq = 0;
			canonicalEvents = body.events
				.filter((e) => e.kind !== 'user_message')
				.flatMap((e) => {
					if (e.kind === 'tool_call') {
						try {
							const parsed = JSON.parse(e.payload) as {
								calls?: Array<{ id: string; name: string; input: unknown }>;
							};
							return (parsed.calls ?? []).map((call) => ({
								id: seq++,
								kind: 'tool.call',
								payload: JSON.stringify({ id: call.id, name: call.name, input: call.input })
							}));
						} catch {
							return [];
						}
					}
					return [{ id: seq++, kind: KIND_MAP[e.kind] ?? e.kind, payload: e.payload }];
				});
			if (!running && liveEvents.length === 0) {
				transcriptMode = 'canonical';
			}
		} catch {
			// Non-fatal
		}
	}

	async function handleSubmit(message: string) {
		if (running) return;

		running = true;
		errorMessage = null;
		streamGapNotice = null;
		currentUserMessage = message;
		transcriptMode = 'live';
		liveEvents = [];

		let model: string | undefined;
		let maxBudgetUsd: number | undefined;
		try {
			const raw = localStorage.getItem('stardust-settings');
			if (raw) {
				const settings = JSON.parse(raw) as { model?: string; maxBudgetUsd?: number };
				if (typeof settings.model === 'string' && settings.model) {
					model = settings.model;
				}
				if (typeof settings.maxBudgetUsd === 'number') {
					maxBudgetUsd = settings.maxBudgetUsd;
				}
			}
		} catch {
			// Ignore parse errors
		}

		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/turn`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message, model, maxBudgetUsd })
			});

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const body = (await response.json()) as {
				accepted: boolean;
				runId: string;
				streamUrl: string;
			};

			if (!body.accepted) {
				throw new Error('Turn was not accepted by the session workflow');
			}

			await consumeStream(body.streamUrl);
		} catch (caught) {
			errorMessage = caught instanceof Error ? caught.message : 'Unknown error';
		} finally {
			running = false;
			abortController = null;
			void loadLatestRunInspector();
		}
	}

	async function consumeStream(streamUrl: string): Promise<void> {
		abortController = new AbortController();
		const { signal } = abortController;

		const response = await fetch(streamUrl, { signal });
		if (!response.ok || !response.body) return;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';

				for (const frame of frames) {
					parseAndApplyFrame(frame);
				}
			}
		} catch (caught) {
			if (caught instanceof Error && caught.name !== 'AbortError') {
				throw caught;
			}
		} finally {
			reader.releaseLock();
		}
	}

	function parseAndApplyFrame(frame: string): void {
		const lines = frame.split('\n');
		let id: number | undefined;
		let kind = '';
		let data = '';

		for (const line of lines) {
			if (line.startsWith('id: ')) {
				id = Number(line.slice(4));
			} else if (line.startsWith('event: ')) {
				kind = line.slice(7);
			} else if (line.startsWith('data: ')) {
				data = line.slice(6);
			}
		}

		if (!kind || !data) return;

		if (kind === 'stream.gap') {
			streamGapNotice = 'Live stream gap detected; rebuilt from transcript_events.';
			transcriptMode = 'canonical';
			void loadTranscript().then(() => loadLatestRunInspector());
			return;
		}

		liveEvents = [...liveEvents, { id: id ?? liveEvents.length, kind, payload: data }];
	}

	async function loadLatestRunInspector() {
		try {
			const runsResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/runs`);
			if (!runsResponse.ok) return;
			const runsBody = (await runsResponse.json()) as {
				runs: Array<{ id: string; createdAt: string }>;
			};
			if (runsBody.runs.length === 0) return;

			const sorted = [...runsBody.runs].sort(
				(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
			const latestRunId = sorted[0].id;

			const inspectorResponse = await fetch(
				`/api/sessions/${encodeURIComponent(sessionKey)}/runs/${encodeURIComponent(latestRunId)}/inspector`
			);
			if (!inspectorResponse.ok) return;
			inspector = (await inspectorResponse.json()) as RunInspectorProjection;
		} catch {
			// Non-fatal
		}
	}

	/** Count of tool invocations for the "Run · N steps" tablet toggle label. */
	const runStepCount = $derived(inspector?.toolInvocations?.length ?? 0);

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

	/** Compact number formatter: 48123 → "48k", 1200000 → "1.2M". */
	function formatCompact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return `${n}`;
	}

	const budgetSpend = $derived(inspector?.run.usage?.estimatedCostUsd ?? null);
	const budgetMax = $derived(inspector?.run.budget?.maxEstimatedCostUsd ?? null);
	const budgetPercent = $derived(
		budgetMax != null && budgetSpend != null && budgetMax > 0
			? Math.min(100, (budgetSpend / budgetMax) * 100)
			: 0
	);
	const budgetTokensUsed = $derived(
		inspector?.run.usage ? inspector.run.usage.inputTokens + inspector.run.usage.outputTokens : null
	);
	const budgetTokensMax = $derived(inspector?.run.budget?.maxTokens ?? null);
	const budgetModelCalls = $derived(
		inspector?.transcript.filter((e) => e.kind === 'assistant_message').length ?? null
	);

	/** Build a Cinder ApprovalOperation from the session toolCall. */
	function toApprovalOperation(toolCall: { name: string; arguments: unknown }): ApprovalOperation {
		const args = toolCall.arguments;
		if (typeof args === 'object' && args !== null) {
			const obj = args as Record<string, unknown>;
			if (typeof obj.command === 'string') {
				return { kind: 'command', command: obj.command, argsPreview: args };
			}
			if (typeof obj.cmd === 'string') {
				return { kind: 'command', command: obj.cmd, argsPreview: args };
			}
		}
		return { kind: 'other', argsPreview: args };
	}

	async function loadPendingApproval() {
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/approvals`);
			if (!response.ok) return;
			const body = (await response.json()) as { approvals: PendingApprovalEntry[] };
			const entry = body.approvals.find((a) => a.status === 'pending') ?? null;
			pendingApproval = entry;
			if (entry) approvalSlideOverOpen = true;
		} catch {
			// Non-fatal — page works normally without pending approval
		}
	}

	async function resolveSessionApproval(approvalId: string, action: 'approve' | 'deny') {
		try {
			await fetch(`/api/approvals/${approvalId}/resolve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
		} catch {
			// Non-fatal
		} finally {
			pendingApproval = null;
			approvalSlideOverOpen = false;
		}
	}

	async function handleSteer(message: string) {
		await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/steer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message })
		});
	}

	async function handleInterrupt() {
		abortController?.abort();
		try {
			await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/interrupt`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
		} catch {
			// Non-fatal
		}
	}
</script>

<svelte:head>
	<title>Session — Stardust</title>
</svelte:head>

<div class="session-page">
	{#if errorMessage}
		<div class="error-banner" role="alert">
			{errorMessage}
		</div>
	{/if}

	{#if pendingApproval !== null && !isRecovered}
		<div class="attention-bar" role="alert">
			<!-- lucide shield-alert -->
			<svg
				class="attention-icon"
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
			<div class="attention-content">
				<div class="attention-title">The agent is waiting for your approval to continue</div>
				<div class="attention-sub">
					High-risk command on session {sessionKey} · the run is paused on a durable wait, nothing has
					executed
				</div>
			</div>
			<span class="spacer"></span>
			<button
				type="button"
				class="attention-open-btn"
				onclick={() => (approvalSlideOverOpen = true)}
			>
				<span class="attention-signal"
					>signal: human_approval · {pendingApproval.approvalId.slice(0, 10)}</span
				>
			</button>
		</div>
	{/if}

	{#if isRecovered}
		<RecoveryView projection={inspector} />
	{:else}
		<!-- Tablet toggle bar (641–1024px only) — hidden on desktop and phone via CSS -->
		<div class="tablet-bar">
			<div class="tablet-bar-row">
				<SegmentedControl
					id="session-pane-toggle"
					label="Session pane"
					selectionMode="single"
					size="sm"
					bind:value={tabletView}
				>
					<Segment value="conversation">Conversation</Segment>
					<Segment value="run"
						>Run{#if runStepCount > 0}
							· {runStepCount} steps{/if}</Segment
					>
				</SegmentedControl>
				<span class="spacer"></span>
				<span class="inspector-chip">wf_{sessionKey.slice(0, 4)}</span>
			</div>
			<DurabilityRibbon evidence={inspector?.durabilityEvidence ?? null} compact />
		</div>
		<div class="split-surface" class:tablet-show-run={tabletView === 'run'}>
			<div class="conversation-pane">
				<div class="pane-header">
					<!-- lucide messages-square -->
					<svg
						class="pane-icon"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
						<path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
					</svg>
					<span class="pane-title">Conversation</span>
					<span class="spacer"></span>
					{#if events.length > 0}
						<span class="pane-meta">{events.length} events</span>
					{/if}
					<SegmentedControl
						id="transcript-mode"
						label="Transcript mode"
						selectionMode="single"
						size="sm"
						bind:value={transcriptMode}
					>
						<Segment value="live">Live</Segment>
						<Segment value="canonical">Canonical</Segment>
					</SegmentedControl>
				</div>
				{#if streamGapNotice}
					<div class="stream-gap-notice" role="status">{streamGapNotice}</div>
				{/if}
				<div class="chat-area">
					<ConversationView
						sessionId={sessionKey}
						userMessage={currentUserMessage ? { text: currentUserMessage } : null}
						{events}
						{running}
						onSubmit={handleSubmit}
						onRetry={currentUserMessage ? () => handleSubmit(currentUserMessage!) : null}
						onSteer={handleSteer}
						onInterrupt={handleInterrupt}
					/>
				</div>
			</div>

			{#if pendingApproval !== null && approvalSlideOverOpen}
				{@const approval = pendingApproval}
				<div class="approval-backdrop" aria-hidden="true"></div>
				<aside class="approval-slide-over" aria-label="Approval required">
					<div class="approval-slide-header">
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
						<span class="approval-slide-title">Approval required</span>
						<span class="spacer"></span>
						<button
							type="button"
							class="icon-btn"
							aria-label="Close approval panel"
							onclick={() => (approvalSlideOverOpen = false)}
						>
							<!-- lucide x -->
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M18 6 6 18" />
								<path d="m6 6 12 12" />
							</svg>
						</button>
					</div>
					<div class="approval-slide-body">
						<ApprovalCard
							tool={{ name: approval.toolCall.name, risk: 'high' }}
							operation={toApprovalOperation(approval.toolCall)}
							policyVersion="policy-2026-06"
							idempotencyKey={approval.approvalId}
							expiresAt={approval.expiresAt}
							state="pending"
							editableArgs={true}
							onapprove={() => resolveSessionApproval(approval.approvalId, 'approve')}
							ondeny={() => resolveSessionApproval(approval.approvalId, 'deny')}
							onapprovewithedits={() => resolveSessionApproval(approval.approvalId, 'approve')}
						/>
					</div>
				</aside>
			{/if}

			{#if inspector && inspectorOpen}
				<aside class="inspector-pane" aria-label="Run inspector">
					<div class="inspector-header">
						<!-- lucide activity -->
						<svg
							class="pane-icon"
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
								d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
							/>
						</svg>
						<span class="pane-title">Run inspector</span>
						<span class="spacer"></span>
						<span class="inspector-chip">wf_{sessionKey.slice(0, 4)}</span>
						<button
							type="button"
							class="icon-btn"
							aria-label="Maximize inspector"
							onclick={() => (inspectorOpen = false)}
						>
							<!-- lucide maximize-2 -->
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<polyline points="15 3 21 3 21 9" />
								<polyline points="9 21 3 21 3 15" />
								<line x1="21" y1="3" x2="14" y2="10" />
								<line x1="3" y1="21" x2="10" y2="14" />
							</svg>
						</button>
					</div>

					<div class="inspector-durability-wrapper">
						<DurabilityRibbon evidence={inspector.durabilityEvidence} />
					</div>

					<dl class="inspector-metadata" aria-label="Run execution metadata">
						<div class="inspector-metadata-item">
							<dt>Workflow</dt>
							<dd>{inspector.run.workflowId}</dd>
						</div>
						<div class="inspector-metadata-item">
							<dt>Task queue</dt>
							<dd>{inspector.taskQueues.join(', ')}</dd>
						</div>
						<div class="inspector-metadata-item">
							<dt>Temporal run</dt>
							<dd>{inspector.run.temporalRunId ?? 'not available'}</dd>
						</div>
					</dl>

					<div class="demo-prompt-strip" aria-label="Demo prompts">
						{#each demoPrompts as prompt (prompt.label)}
							<button
								type="button"
								class="demo-prompt-chip"
								disabled={running}
								onclick={() => handleSubmit(prompt.message)}
							>
								{prompt.label}
							</button>
						{/each}
					</div>

					<div class="budget-bar">
						{#if budgetSpend != null && budgetMax != null}
							<div class="budget-row">
								<span class="budget-label">Budget</span>
								<span class="budget-value">${budgetSpend.toFixed(2)} / ${budgetMax.toFixed(2)}</span
								>
							</div>
							<div class="budget-track">
								<div class="budget-fill" style="width: {budgetPercent}%"></div>
							</div>
							<div class="budget-meta">
								{budgetTokensUsed == null ? 'not available' : formatCompact(budgetTokensUsed)} /
								{budgetTokensMax == null ? 'not available' : formatCompact(budgetTokensMax)}
								tokens · {budgetModelCalls == null ? 'not available' : budgetModelCalls} model calls
							</div>
						{:else}
							<div class="budget-row">
								<span class="budget-label">Budget</span>
								<span class="budget-value">not available</span>
							</div>
						{/if}
					</div>

					<div class="inspector-body">
						<RunTimeline projection={inspector} engineerView={viewMode.isEngineer} />
					</div>

					<div class="inspector-status-bar">
						{#if running}
							<span class="status-dot dot-live"></span>
							<span class="status-text">Streaming live · steer or interrupt anytime</span>
							<span class="spacer"></span>
							<Button variant="danger" size="sm" onclick={handleInterrupt}>
								<span class="btn-content">
									<!-- lucide square -->
									<svg
										width="13"
										height="13"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<rect x="3" y="3" width="18" height="18" rx="2" />
									</svg>
									Interrupt
								</span>
							</Button>
						{:else}
							<span class="status-dot dot-idle"></span>
							<span class="status-text">Idle</span>
						{/if}
					</div>
				</aside>
			{/if}
		</div>

		{#if inspector && !inspectorOpen}
			<button
				type="button"
				class="inspector-toggle"
				aria-label="Open inspector"
				onclick={() => (inspectorOpen = true)}
			>
				<!-- lucide chevron-left -->
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
					<path d="m15 18-6-6 6-6" />
				</svg>
			</button>
		{/if}

		<!-- Phone surfaces (≤640px) — hidden on desktop and tablet via CSS -->
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
						<span class="p3rib-l">gaps</span>
					</div>
					<div class="p3rib">
						<span class="p3rib-n p3rib-success"
							>{inspector?.durabilityEvidence.retryAttemptCount ?? '—'}</span
						>
						<span class="p3rib-l">retry</span>
					</div>
					<div class="p3rib">
						<span class="p3rib-n p3rib-accent">{phoneDurableEventId}</span>
						<span class="p3rib-l">transcript</span>
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
						onclick={() => resolveSessionApproval(phoneApproval.approvalId, 'approve')}
					>
						Approve
					</Button>
					<div class="phone-approval-secondary">
						<Button
							variant="soft-danger"
							fullWidth
							onclick={() => resolveSessionApproval(phoneApproval.approvalId, 'deny')}
						>
							Deny
						</Button>
						<Button
							variant="soft"
							fullWidth
							onclick={() => resolveSessionApproval(phoneApproval.approvalId, 'approve')}
						>
							Remember
						</Button>
					</div>
					<p class="phone-approval-note">Editing arguments opens on desktop</p>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.session-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	.error-banner {
		padding: 10px 20px;
		background: var(--cinder-color-danger-bg);
		border-bottom: 1px solid var(--cinder-color-danger-border);
		color: var(--cinder-color-danger-fg);
		font-size: var(--cinder-text-sm);
		flex: none;
	}

	.split-surface {
		display: flex;
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	.conversation-pane {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		border-right: 1px solid var(--cinder-border);
	}

	.pane-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex: none;
	}

	.pane-icon {
		color: var(--cinder-text-subtle);
		flex-shrink: 0;
	}

	.pane-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.pane-meta {
		font: 500 11px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		padding: 2px 8px;
		background: var(--cinder-surface-inset);
		border-radius: var(--cinder-radius-sm);
	}

	.stream-gap-notice {
		flex: none;
		padding: 7px 14px;
		border-bottom: 1px solid var(--cinder-color-warning-border);
		background: var(--cinder-color-warning-bg);
		color: var(--cinder-color-warning-fg);
		font: 500 12px / 1.35 system-ui;
	}

	.spacer {
		flex: 1;
	}

	.chat-area {
		flex: 1;
		overflow: hidden;
		background: var(--cinder-bg);
	}

	.inspector-pane {
		width: 556px;
		flex: none;
		display: flex;
		flex-direction: column;
		background: var(--cinder-surface);
		overflow: hidden;
	}

	.inspector-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex: none;
	}

	.inspector-chip {
		font: 500 11px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		padding: 2px 8px;
		background: var(--cinder-surface-inset);
		border-radius: var(--cinder-radius-sm);
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--cinder-radius-sm);
		background: transparent;
		color: var(--cinder-text-subtle);
		cursor: pointer;
	}

	.icon-btn:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	.inspector-metadata {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		margin: 0;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: var(--cinder-surface-inset);
		flex: none;
	}

	.inspector-metadata-item {
		min-width: 0;
		padding: 8px 12px;
		border-right: 1px solid var(--cinder-border-muted);
	}

	.inspector-metadata-item:last-child {
		border-right: 0;
	}

	.inspector-metadata dt {
		margin: 0;
		font: 700 10px system-ui;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
	}

	.inspector-metadata dd {
		margin: 2px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 500 12px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text);
	}

	.demo-prompt-strip {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		gap: 6px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: var(--cinder-bg);
	}

	.demo-prompt-chip {
		border: 1px solid var(--cinder-border-muted);
		border-radius: 999px;
		padding: 4px 9px;
		background: var(--cinder-surface);
		color: var(--cinder-text);
		font: 650 11px / 1.2 system-ui;
		cursor: pointer;
	}

	.demo-prompt-chip:hover:not(:disabled) {
		border-color: var(--cinder-accent);
		color: var(--cinder-accent-text);
	}

	.demo-prompt-chip:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.budget-bar {
		padding: 8px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex: none;
	}

	.budget-row {
		display: flex;
		justify-content: space-between;
		font: 600 10.5px system-ui;
	}

	.budget-label {
		color: var(--cinder-text-subtle);
	}

	.budget-value {
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text);
	}

	.budget-track {
		height: 6px;
		border-radius: 3px;
		background: var(--cinder-surface-inset);
		margin-top: 5px;
		overflow: hidden;
	}

	.budget-fill {
		height: 100%;
		background: var(--cinder-accent);
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.budget-meta {
		font: 500 9.5px/1 system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 4px;
	}

	.inspector-body {
		flex: 1;
		overflow-y: auto;
		padding: 16px 14px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.inspector-status-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-top: 1px solid var(--cinder-border);
		flex: none;
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-live {
		background: var(--cinder-info);
		animation: pulse 2s ease-in-out infinite;
	}

	.dot-idle {
		background: var(--cinder-text-disabled);
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

	.status-text {
		font: 500 11.5px system-ui;
		color: var(--cinder-text-subtle);
	}

	.btn-content {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.inspector-toggle {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 48px;
		border: 1px solid var(--cinder-border);
		border-right: none;
		border-radius: var(--cinder-radius-md) 0 0 var(--cinder-radius-md);
		background: var(--cinder-surface);
		color: var(--cinder-text-subtle);
		cursor: pointer;
	}

	.inspector-toggle:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	@media (max-width: 1024px) {
		/* Show the segmented toggle bar */
		.tablet-bar {
			display: flex;
		}

		/* Inspector pane fills the full width when active */
		.inspector-pane {
			width: 100%;
			border-left: none;
		}

		/* Desktop-only elements hidden on tablet */
		.pane-header,
		.inspector-header,
		.inspector-metadata,
		.budget-bar,
		.inspector-durability-wrapper,
		.inspector-toggle {
			display: none;
		}

		/* Default tablet state: show conversation, hide inspector */
		.split-surface .inspector-pane {
			display: none;
		}

		/* Run view: hide conversation, show inspector full-width */
		.split-surface.tablet-show-run .conversation-pane {
			display: none;
		}
		.split-surface.tablet-show-run .inspector-pane {
			display: flex;
		}
	}

	@media (max-width: 640px) {
		/* Hide desktop/tablet UI entirely */
		.tablet-bar,
		.split-surface,
		.inspector-toggle,
		.attention-bar,
		.approval-backdrop,
		.approval-slide-over {
			display: none;
		}

		/* Show phone surfaces */
		.phone-monitor,
		.phone-approval-surface {
			display: flex;
			flex-direction: column;
			flex: 1;
			overflow-y: auto;
			min-height: 0;
		}
	}

	/* ── Attention bar ── */

	.attention-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 11px 18px;
		background: var(--cinder-color-warning-bg);
		border-bottom: 1px solid var(--cinder-color-warning-border);
		flex: none;
	}

	.attention-icon {
		color: var(--cinder-color-warning-fg);
		flex-shrink: 0;
	}

	.attention-content {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.attention-title {
		font: 600 12.5px system-ui;
		color: var(--cinder-color-warning-fg);
	}

	.attention-sub {
		font: 400 11px system-ui;
		color: var(--cinder-color-warning-fg);
		opacity: 0.85;
	}

	.attention-open-btn {
		all: unset;
		cursor: pointer;
	}

	.attention-signal {
		font: 500 10px var(--cinder-font-mono);
		color: var(--cinder-color-warning-fg);
		opacity: 0.8;
		padding: 2px 8px;
		background: color-mix(in srgb, var(--cinder-color-warning-fg) 12%, transparent);
		border-radius: var(--cinder-radius-sm);
		white-space: nowrap;
	}

	/* ── Approval slide-over ── */

	.approval-backdrop {
		position: absolute;
		inset: 0;
		background: var(--cinder-overlay-backdrop);
		z-index: 9;
	}

	.approval-slide-over {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 512px;
		background: var(--cinder-surface);
		border-left: 1px solid var(--cinder-border);
		box-shadow: -12px 0 40px -16px rgba(0, 0, 0, 0.7);
		display: flex;
		flex-direction: column;
		z-index: 10;
	}

	.approval-slide-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex: none;
		color: var(--cinder-text-subtle);
	}

	.approval-slide-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.approval-slide-body {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	/* ── Tablet bar ── */

	.tablet-bar {
		display: none;
		flex-direction: column;
		flex: none;
		background: var(--cinder-surface);
		border-bottom: 1px solid var(--cinder-border);
	}

	.tablet-bar-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--cinder-border-muted);
	}

	/* ── Phone surfaces — hidden by default, shown on ≤640px ── */

	.phone-monitor,
	.phone-approval-surface {
		display: none;
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

	/* ── Phone 3-col ribbon ── */

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

	/* ── Phone step list ── */

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

	/* ── Phone nudge card ── */

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

	/* ── Phone approval surface ── */

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
