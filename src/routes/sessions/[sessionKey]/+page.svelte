<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '@lostgradient/cinder/button';
	import ConversationView, { type StreamEvent } from '$lib/components/ConversationView.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import DurabilityRibbon from '$lib/components/DurabilityRibbon.svelte';
	import RunTimeline from '$lib/components/RunTimeline.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import { viewMode } from '$lib/view-mode.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const sessionKey = $derived(data.sessionKey);

	let running = $state(false);
	let events = $state<StreamEvent[]>([]);
	let currentUserMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let inspector = $state.raw<RunInspectorProjection | null>(null);
	let inspectorOpen = $state(true);

	let abortController: AbortController | null = null;

	onMount(() => {
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
			events = body.events
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
		} catch {
			// Non-fatal
		}
	}

	async function handleSubmit(message: string) {
		if (running) return;

		running = true;
		errorMessage = null;
		currentUserMessage = message;
		events = [];

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

		if (!kind || !data || kind === 'stream.gap') return;

		events = [...events, { id: id ?? events.length, kind, payload: data }];
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

	<div class="split-surface">
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
			</div>
			<div class="stream-area" aria-label="Message stream" aria-live="polite">
				<ConversationView
					userMessage={currentUserMessage ? { text: currentUserMessage } : null}
					{events}
					{running}
					onRetry={currentUserMessage ? () => handleSubmit(currentUserMessage!) : null}
				/>
			</div>

			<div class="composer-area">
				<Composer
					{running}
					onSubmit={handleSubmit}
					onSteer={handleSteer}
					onInterrupt={handleInterrupt}
				/>
			</div>
		</div>

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

				<DurabilityRibbon />

				<div class="inspector-chips">
					<span class="chip">activity agentSession</span>
					<span class="chip">queue agent-main</span>
					<span class="chip">attempt 1</span>
				</div>

				<div class="inspector-body">
					<RunTimeline projection={inspector} engineerView={viewMode.mode === 'engineer'} />
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

	.spacer {
		flex: 1;
	}

	.stream-area {
		flex: 1;
		overflow-y: auto;
		background: var(--cinder-bg);
	}

	.composer-area {
		flex: none;
		border-top: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
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

	.inspector-chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		padding: 8px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		flex: none;
	}

	.chip {
		font: 500 11px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		padding: 3px 8px;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
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
		.inspector-pane {
			width: 360px;
		}
	}

	@media (max-width: 640px) {
		.split-surface {
			flex-direction: column;
		}

		.inspector-pane {
			width: 100%;
			max-height: 50%;
			border-left: none;
			border-top: 1px solid var(--cinder-border);
		}

		.inspector-toggle {
			display: none;
		}
	}
</style>
