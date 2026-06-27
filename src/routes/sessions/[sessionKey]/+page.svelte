<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ConversationView, { type StreamEvent } from '$lib/components/ConversationView.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const sessionKey = $derived(data.sessionKey);

	// — conversation state —
	let running = $state(false);
	let events = $state<StreamEvent[]>([]);
	let currentUserMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	// — SSE abort controller —
	let abortController: AbortController | null = null;

	// Auto-submit the initial message when navigating from the home composer,
	// or rehydrate the conversation from the transcript when resuming.
	onMount(() => {
		if (data.startMessage) {
			// Clear the ?start= param from the URL immediately so refresh doesn't re-submit.
			void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`), { replaceState: true });
			void handleSubmit(data.startMessage);
		} else {
			void loadTranscript();
		}
	});

	/**
	 * Fetch the canonical transcript for this session and populate the render state.
	 * Transcript kinds use underscore-style (e.g. tool_call); the ConversationView
	 * expects dot-style (e.g. tool.call), so we normalise on the way in.
	 */
	async function loadTranscript() {
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/transcript`);
			if (!response.ok) return; // 404 = new session, that's fine

			const body = (await response.json()) as {
				events: Array<{ id: string; kind: string; payload: string; sequence: number }>;
			};

			// Extract the last user_message as the current user message header.
			const userMsgEvents = body.events.filter((e) => e.kind === 'user_message');
			if (userMsgEvents.length > 0) {
				const lastUserMsg = userMsgEvents[userMsgEvents.length - 1];
				try {
					const parsed = JSON.parse(lastUserMsg.payload) as { message?: string };
					currentUserMessage = parsed.message ?? null;
				} catch {
					// ignore malformed payload
				}
			}

			// Map transcript kinds (underscore) → stream event kinds (dot).
			const KIND_MAP: Record<string, string> = {
				assistant_message: 'assistant.message',
				tool_call: 'tool.call',
				tool_result: 'tool.result',
				approval_request: 'approval.request',
				approval_resolution: 'approval.resolution',
				lifecycle: 'lifecycle'
				// user_message is rendered via currentUserMessage above
			};

			events = body.events
				.filter((e) => e.kind !== 'user_message')
				.map((e, index) => ({
					id: index,
					kind: KIND_MAP[e.kind] ?? e.kind,
					payload: e.payload
				}));
		} catch {
			// Non-fatal: the conversation simply starts fresh if transcript can't be loaded.
		}
	}

	async function handleSubmit(message: string) {
		if (running) return;

		running = true;
		errorMessage = null;
		currentUserMessage = message;
		events = [];

		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/turn`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message })
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

			// Open the SSE stream using fetch + ReadableStream so that named
			// events are dispatched correctly. EventSource.onmessage only fires
			// for un-named frames and would miss all events here.
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

				// Parse SSE frames: each frame is separated by a blank line.
				const frames = buffer.split('\n\n');
				// Keep the incomplete last chunk in the buffer.
				buffer = frames.pop() ?? '';

				for (const frame of frames) {
					parseAndApplyFrame(frame);
				}
			}
		} catch (caught) {
			// AbortError is expected when the user interrupts.
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

		// Append the event to the reactive list. The ConversationView derives
		// its render model from this array.
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
		// Abort the client-side SSE read first so the UI stops waiting.
		abortController?.abort();
		// Then tell the server to cancel the active run.
		try {
			await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/interrupt`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
		} catch {
			// Non-fatal: the run will time out naturally if this fails.
		}
	}
</script>

<svelte:head>
	<title>Session — Stardust</title>
</svelte:head>

<div class="conversation-page">
	<header class="page-header">
		<div class="header-left">
			<a href={resolve('/')} class="back-link" aria-label="Back to sessions">← Sessions</a>
			<h1 class="session-title" title={sessionKey}>{sessionKey}</h1>
		</div>
		<div class="header-right">
			<a href={resolve('/ops')} class="ops-link" aria-label="Open operator console">Ops ↗</a>
		</div>
	</header>

	{#if errorMessage}
		<div class="error-banner" role="alert">
			{errorMessage}
		</div>
	{/if}

	<div class="stream-area" aria-label="Message stream" aria-live="polite">
		<ConversationView
			userMessage={currentUserMessage ? { text: currentUserMessage } : null}
			{events}
			{running}
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

<style>
	:global(body) {
		margin: 0;
		background: #f6f7f8;
		color: #1d252c;
		font-family:
			Inter,
			ui-sans-serif,
			system-ui,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}

	.conversation-page {
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		height: 100dvh;
		overflow: hidden;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 20px;
		border-bottom: 1px solid #d7dde2;
		background: #ffffff;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.back-link {
		color: #5e6f80;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.back-link:hover {
		color: #174c77;
	}

	.session-title {
		margin: 0;
		font-size: 0.95rem;
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: #1d252c;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-right {
		flex-shrink: 0;
	}

	.ops-link {
		color: #5e6f80;
		text-decoration: none;
		font-size: 0.8rem;
		font-weight: 700;
	}

	.ops-link:hover {
		color: #174c77;
	}

	.error-banner {
		padding: 10px 20px;
		background: #fff1f1;
		border-bottom: 1px solid #f5c6c6;
		color: #7b1d1d;
		font-size: 0.875rem;
	}

	.stream-area {
		overflow-y: auto;
		background: #ffffff;
	}

	.composer-area {
		border-top: 1px solid #d7dde2;
		background: #ffffff;
	}
</style>
