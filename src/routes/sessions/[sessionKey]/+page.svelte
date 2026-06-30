<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ConversationView, { type StreamEvent } from '$lib/components/ConversationView.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const sessionKey = $derived(data.sessionKey);

	let running = $state(false);
	let events = $state<StreamEvent[]>([]);
	let currentUserMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	let abortController: AbortController | null = null;

	onMount(() => {
		if (data.startMessage) {
			void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`), { replaceState: true });
			void handleSubmit(data.startMessage);
		} else {
			void loadTranscript();
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

	<div class="conversation-pane">
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
</div>

<style>
	.session-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.error-banner {
		padding: 10px 20px;
		background: var(--cinder-color-danger-bg);
		border-bottom: 1px solid var(--cinder-color-danger-border);
		color: var(--cinder-color-danger-fg);
		font-size: var(--cinder-text-sm);
		flex: none;
	}

	.conversation-pane {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow: hidden;
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
</style>
