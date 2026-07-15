<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page as currentPage } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import Badge from '@lostgradient/cinder/badge';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import Segment from '@lostgradient/cinder/segment';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import type { StatusDotStatus } from '@lostgradient/cinder/status-dot';
	import { onDestroy } from 'svelte';
	import ConversationView from '$lib/components/conversation-view.svelte';
	import DurabilityRibbon from '$lib/components/durability-ribbon.svelte';
	import RecoveryView from '$lib/components/recovery-view.svelte';
	import RunPane from '$lib/components/run-pane.svelte';
	import SessionPhoneSurfaces from '$lib/components/session-phone-surfaces.svelte';
	import { sessionBadgeVariant } from '$lib/components/session-row.svelte';
	import { formatStatus } from '$lib/session-display';
	import { bootstrapSessionPage } from '$lib/session-page-bootstrap';
	import {
		SessionReconnection,
		findLatestRunId,
		isTerminalRunStatus,
		transcriptHasTerminalEvent,
		transcriptHasUnsettledRun,
		type SessionReconnectionSnapshot,
		type SessionReconnectionState
	} from '$lib/session-reconnection';
	import { parseSseFrame, readSseStream } from '$lib/sse-stream';
	import {
		findLastUserMessageText,
		mapTranscriptToStreamEvents,
		type StreamEvent,
		type TranscriptEventRow
	} from '$lib/stream-to-conversation';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import type { PendingApprovalEntry, SessionAttachmentInput } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const sessionKey = $derived(data.sessionKey);

	/**
	 * Extract a human-readable message from a failed response. SvelteKit's
	 * `error(status, message)` returns a JSON body `{ "message": ... }`; fall back
	 * to the raw text for non-JSON error bodies.
	 */
	async function readErrorMessage(response: Response): Promise<string> {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { message?: unknown };
			if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
		} catch {
			// Not JSON — fall through to the raw text.
		}
		return text || `Request failed (${response.status})`;
	}

	let running = $state(false);
	let liveEvents = $state<StreamEvent[]>([]);
	let canonicalEvents = $state<StreamEvent[]>([]);
	let canonicalTranscript = $state.raw<TranscriptEventRow[]>([]);
	let transcriptMode = $state<'live' | 'canonical'>('live');
	let events = $derived(transcriptMode === 'live' ? liveEvents : canonicalEvents);
	let currentUserMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let streamGapNotice = $state<string | null>(null);
	let inspector = $state.raw<RunInspectorProjection | null>(null);
	let runCount = $state<number | null>(null);

	let pendingApproval = $state<PendingApprovalEntry | null>(null);
	let approvalResolution = $state<'approve' | 'deny' | null>(null);

	/** Replay cursor over the durable transcript. Null means live. */
	let scrubCursor = $state<number | null>(null);

	const isRecovered = $derived(inspector?.run.status === 'recovered');

	let abortController: AbortController | null = null;
	let reconnectionState = $state<SessionReconnectionState>({ kind: 'dormant' });
	let destroyed = false;
	const reconnectedRunActive = $derived(
		reconnectionState.kind !== 'dormant' && reconnectionState.kind !== 'failed-unobservable'
	);
	const runActive = $derived(running || reconnectedRunActive);
	const acceptsSteering = $derived(
		running ||
			reconnectionState.kind === 'observing' ||
			reconnectionState.kind === 'awaiting-approval'
	);

	const reconnection = new SessionReconnection({
		readSnapshot: readReconnectionSnapshot,
		applySnapshot: applyReconnectionSnapshot,
		setState: (state) => {
			reconnectionState = state;
			if (state.kind === 'failed-unobservable') errorMessage = state.message;
		}
	});

	/** Controls which pane is active on tablet (641–1024px). */
	let tabletView = $state<'conversation' | 'run'>('conversation');

	// SvelteKit reuses this component when only the [sessionKey] param changes
	// (e.g. jumping between sessions from the command palette), so per-session
	// state must reset and reload on every navigation, not just on mount.
	let initializedSessionKey: string | null = null;
	afterNavigate(() => {
		if (initializedSessionKey === sessionKey) return;
		initializedSessionKey = sessionKey;
		const targetSessionKey = sessionKey;

		abortController?.abort();
		abortController = null;
		reconnection.stop();
		running = false;
		liveEvents = [];
		canonicalEvents = [];
		canonicalTranscript = [];
		transcriptMode = 'live';
		currentUserMessage = null;
		errorMessage = null;
		streamGapNotice = null;
		inspector = null;
		runCount = null;
		pendingApproval = null;
		approvalResolution = null;
		scrubCursor = null;
		reconnectionState = { kind: 'dormant' };

		if (data.startMessage) {
			void goto(resolve(`/sessions/${encodeURIComponent(sessionKey)}`), { replaceState: true });
		}

		void bootstrapSessionPage({
			fresh: data.fresh,
			startMessage: data.startMessage,
			loadPendingApproval,
			loadTranscript,
			loadLatestRunInspector,
			submitFirstTurn: handleSubmit
		}).then(() => {
			if (!isCurrentSession(targetSessionKey)) return;
			if (data.fresh || data.startMessage) return;
			const latestStatus = inspector?.run.status;
			const terminalInspectorNeedsSettlement =
				inspector != null &&
				isTerminalRunStatus(latestStatus) &&
				!transcriptHasTerminalEvent(canonicalTranscript, inspector.run.id, latestStatus!);
			if (
				terminalInspectorNeedsSettlement ||
				(inspector != null && !isTerminalRunStatus(latestStatus)) ||
				transcriptHasUnsettledRun(canonicalTranscript)
			) {
				transcriptMode = 'canonical';
				reconnection.start();
			}
		});
	});

	onDestroy(() => {
		destroyed = true;
		abortController?.abort();
		reconnection.stop();
	});

	function isCurrentSession(targetSessionKey: string): boolean {
		return !destroyed && targetSessionKey === sessionKey;
	}

	async function fetchTranscript(
		targetSessionKey: string,
		signal?: AbortSignal
	): Promise<TranscriptEventRow[]> {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(targetSessionKey)}/transcript`,
			{ cache: 'no-store', signal }
		);
		if (!response.ok) throw new Error(`Transcript request failed (${response.status})`);
		const body = (await response.json()) as { events: TranscriptEventRow[] };
		return body.events;
	}

	function applyTranscript(rows: TranscriptEventRow[]) {
		canonicalTranscript = rows;
		currentUserMessage = findLastUserMessageText(rows);
		canonicalEvents = mapTranscriptToStreamEvents(rows);
		if (!running && liveEvents.length === 0) transcriptMode = 'canonical';
	}

	async function loadTranscript(targetSessionKey = sessionKey) {
		try {
			const rows = await fetchTranscript(targetSessionKey);
			if (!isCurrentSession(targetSessionKey)) return;
			applyTranscript(rows);
		} catch {
			// Non-fatal
		}
	}

	async function handleSubmit(message: string, attachments?: SessionAttachmentInput[]) {
		if (runActive) return;

		running = true;
		errorMessage = null;
		streamGapNotice = null;
		currentUserMessage = message;
		transcriptMode = 'live';
		// Seed the live view with the conversation so far, then append this turn's
		// user message. The live stream only carries the current run's events, so
		// without this seed the prior turns would vanish while the new one streams.
		// Attachments ride along on this synthetic event only — the durable
		// transcript's user_message payload is text-only, so this preview does
		// not survive a reload (see stream-to-conversation.ts's UserMessage doc).
		liveEvents = [
			...canonicalEvents,
			{
				id: canonicalEvents.length,
				kind: 'user.message',
				payload: JSON.stringify({ text: message, attachments })
			}
		];
		scrubCursor = null;

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
				body: JSON.stringify({ message, model, maxBudgetUsd, attachments })
			});

			if (!response.ok) {
				throw new Error(await readErrorMessage(response));
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
			// Refresh the durable transcript so the next turn seeds from complete history
			// and the Canonical view reflects this turn. Live mode is preserved.
			await loadTranscript();
			if (currentPage.url.searchParams.get('fresh') === '1') {
				const searchParams = new SvelteURLSearchParams(currentPage.url.searchParams);
				searchParams.delete('fresh');
				const nextQueryString = searchParams.toString();
				await goto(
					resolve(
						`/sessions/${encodeURIComponent(sessionKey)}${nextQueryString ? `?${nextQueryString}` : ''}`
					),
					{
						replaceState: true,
						noScroll: true,
						keepFocus: true
					}
				);
			}
		} catch (caught) {
			errorMessage = caught instanceof Error ? caught.message : 'Unknown error';
		} finally {
			running = false;
			abortController = null;
			void loadLatestRunInspector();
		}
	}

	// A freshly-submitted turn returns its runId before the workflow has created the
	// run row, so the stream endpoint 404s for the first ~1–2s. We know the run is
	// pending, so retry the connection with backoff instead of silently giving up
	// (which would leave the turn looking hung with no reply). Capped, then surfaced.
	const STREAM_CONNECT_BACKOFF_MS = [300, 700, 1200, 1800, 2500];

	async function connectToStream(streamUrl: string, signal: AbortSignal): Promise<Response | null> {
		for (let attempt = 0; ; attempt++) {
			if (signal.aborted) return null;
			const response = await fetch(streamUrl, { signal }).catch(() => null);
			if (response?.ok && response.body) return response;
			// Only a "run not started yet" 404 is worth retrying; anything else is a
			// real failure we leave to the caller's normal (quiet) handling.
			if (response && response.status !== 404) return response;
			if (attempt >= STREAM_CONNECT_BACKOFF_MS.length) {
				errorMessage =
					'The run is taking longer than expected to start. Reload to reconnect to the live view.';
				return null;
			}
			await new Promise((resolve) => setTimeout(resolve, STREAM_CONNECT_BACKOFF_MS[attempt]));
		}
	}

	async function consumeStream(streamUrl: string): Promise<void> {
		abortController = new AbortController();
		const { signal } = abortController;

		const response = await connectToStream(streamUrl, signal);
		if (!response || !response.ok || !response.body) return;

		await readSseStream(response.body, signal, (frame) => applyFrame(frame));
	}

	function applyFrame(frame: string): void {
		const parsed = parseSseFrame(frame);
		if (!parsed) return;
		const { id, kind, payload } = parsed;

		if (kind === 'stream.gap') {
			streamGapNotice =
				'Live view reconnected — rebuilt from the durable transcript, nothing lost.';
			transcriptMode = 'canonical';
			void loadTranscript().then(() => loadLatestRunInspector());
			return;
		}

		if (kind === 'approval.request') {
			approvalResolution = null;
			void loadPendingApproval();
		}

		liveEvents = [...liveEvents, { id: id ?? liveEvents.length, kind, payload }];
	}

	async function fetchLatestRunInspector(
		targetSessionKey: string,
		signal?: AbortSignal
	): Promise<{ projection: RunInspectorProjection | null; runCount: number }> {
		const runsResponse = await fetch(`/api/sessions/${encodeURIComponent(targetSessionKey)}/runs`, {
			cache: 'no-store',
			signal
		});
		if (!runsResponse.ok) throw new Error(`Runs request failed (${runsResponse.status})`);
		const runsBody = (await runsResponse.json()) as {
			runs: Array<{ id: string; createdAt: string }>;
		};
		if (runsBody.runs.length === 0) return { projection: null, runCount: 0 };

		const latestRunId = findLatestRunId(runsBody.runs);
		if (latestRunId === null) return { projection: null, runCount: 0 };
		const inspectorResponse = await fetch(
			`/api/sessions/${encodeURIComponent(targetSessionKey)}/runs/${encodeURIComponent(latestRunId)}/inspector`,
			{ cache: 'no-store', signal }
		);
		if (!inspectorResponse.ok) {
			throw new Error(`Inspector request failed (${inspectorResponse.status})`);
		}
		return {
			projection: (await inspectorResponse.json()) as RunInspectorProjection,
			runCount: runsBody.runs.length
		};
	}

	async function loadLatestRunInspector(targetSessionKey = sessionKey) {
		try {
			const latest = await fetchLatestRunInspector(targetSessionKey);
			if (!isCurrentSession(targetSessionKey)) return null;
			runCount = latest.runCount;
			inspector = latest.projection;
			return latest.projection;
		} catch {
			// Non-fatal
			return null;
		}
	}

	async function fetchPendingApproval(
		targetSessionKey: string,
		signal?: AbortSignal
	): Promise<PendingApprovalEntry | null> {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(targetSessionKey)}/approvals`,
			{
				cache: 'no-store',
				signal
			}
		);
		if (!response.ok) throw new Error(`Approvals request failed (${response.status})`);
		const body = (await response.json()) as { approvals: PendingApprovalEntry[] };
		return body.approvals.find((approval) => approval.status === 'pending') ?? null;
	}

	async function loadPendingApproval(targetSessionKey = sessionKey) {
		try {
			const latestApproval = await fetchPendingApproval(targetSessionKey);
			if (!isCurrentSession(targetSessionKey)) return;
			pendingApproval = latestApproval;
		} catch {
			// Non-fatal — page works normally without pending approval
		}
	}

	async function readReconnectionSnapshot(
		signal: AbortSignal
	): Promise<SessionReconnectionSnapshot> {
		const targetSessionKey = sessionKey;
		const pendingApprovalRequest = fetchPendingApproval(targetSessionKey, signal).catch((error) => {
			if (signal.aborted) throw error;
			return null;
		});
		const [transcript, latestRun, latestApproval] = await Promise.all([
			fetchTranscript(targetSessionKey, signal),
			fetchLatestRunInspector(targetSessionKey, signal),
			pendingApprovalRequest
		]);
		return {
			transcript,
			inspector: latestRun.projection,
			runCount: latestRun.runCount,
			pendingApproval: latestApproval
		};
	}

	function applyReconnectionSnapshot(snapshot: SessionReconnectionSnapshot): void {
		applyTranscript(snapshot.transcript);
		inspector = snapshot.inspector;
		runCount = snapshot.runCount;
		pendingApproval = snapshot.pendingApproval;
		transcriptMode = 'canonical';
	}

	async function resolveSessionApproval(
		approvalId: string,
		action: 'approve' | 'approve_with_edits' | 'deny',
		editedArguments?: unknown
	) {
		try {
			await fetch(`/api/approvals/${approvalId}/resolve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					action === 'approve_with_edits' ? { action, editedArguments } : { action }
				)
			});
		} catch {
			// Non-fatal
		} finally {
			pendingApproval = null;
			approvalResolution = action === 'deny' ? 'deny' : 'approve';
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

	/** Count of tool invocations for the "Run · N steps" tablet toggle label. */
	const runStepCount = $derived(inspector?.toolInvocations?.length ?? 0);

	const sessionStatus = $derived(
		pendingApproval !== null
			? 'waiting_approval'
			: runActive
				? 'running'
				: (inspector?.run.status ?? 'idle')
	);

	const stripDot = $derived.by((): StatusDotStatus => {
		if (pendingApproval !== null) return 'warning';
		if (runActive) return 'accent';
		if (sessionStatus === 'failed') return 'danger';
		if (sessionStatus === 'complete' || sessionStatus === 'recovered') return 'success';
		return 'neutral';
	});

	const stripTitle = $derived(
		currentUserMessage
			? currentUserMessage.length > 64
				? `${currentUserMessage.slice(0, 63)}…`
				: currentUserMessage
			: sessionKey
	);

	const stripMeta = $derived.by(() => {
		const parts = [sessionKey];
		if (runCount != null && runCount > 0) parts.push(`run ${runCount}`);
		const spend = inspector?.run.usage?.estimatedCostUsd;
		if (spend != null) parts.push(`$${spend.toFixed(2)} spent`);
		return parts.join(' · ');
	});
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

	<!-- Session strip -->
	<div class="session-strip">
		<a href={resolve('/')} class="back-link">
			<!-- lucide chevron-left -->
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="m15 18-6-6 6-6" />
			</svg>
			Sessions
		</a>
		<span class="strip-divider"></span>
		<StatusDot status={stripDot} label={formatStatus(sessionStatus)} showLabel={false} size="sm" />
		<h1 class="strip-title">{stripTitle}</h1>
		<Badge variant={sessionBadgeVariant(sessionStatus)} size="sm">
			{formatStatus(sessionStatus)}
		</Badge>
		<span class="strip-meta">{stripMeta}</span>
		<span class="spacer"></span>
		{#if inspector}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external Temporal Web URL, not an app route -->
			<a class="strip-temporal" href={inspector.temporalWebUrl} target="_blank" rel="noreferrer">
				<!-- lucide external-link -->
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
					<polyline points="15 3 21 3 21 9" />
					<line x1="10" y1="14" x2="21" y2="3" />
				</svg>
				Temporal Web
			</a>
		{/if}
	</div>

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
				<span class="strip-meta">wf_{sessionKey.slice(0, 4)}</span>
			</div>
			<DurabilityRibbon evidence={inspector?.durabilityEvidence ?? null} compact />
		</div>

		<div class="split-surface" class:tablet-show-run={tabletView === 'run'}>
			<section class="conversation-pane" aria-label="Conversation pane">
				<div class="pane-header">
					<span class="pane-title">Conversation</span>
					<span class="spacer"></span>
					{#if events.length > 0}
						<span class="pane-meta">{events.length} events</span>
					{/if}
					<SegmentedControl
						id="transcript-mode"
						label="Transcript mode"
						hideLabel
						density="toolbar"
						selectionMode="single"
						bind:value={transcriptMode}
					>
						<Segment value="live">Live</Segment>
						<Segment value="canonical">Canonical</Segment>
					</SegmentedControl>
				</div>
				{#if streamGapNotice}
					<div class="stream-gap-notice" role="status">{streamGapNotice}</div>
				{/if}
				{#if runActive && acceptsSteering && pendingApproval === null}
					<div class="steer-strip" role="status">
						<StatusDot connectionState="connected" label="Streaming" showLabel={false} size="sm" />
						<span>Streaming — anything you type steers the run</span>
					</div>
				{/if}
				<div class="chat-area">
					<ConversationView
						sessionId={sessionKey}
						userMessage={null}
						{events}
						{runActive}
						{acceptsSteering}
						onSubmit={handleSubmit}
						onRetry={currentUserMessage ? () => handleSubmit(currentUserMessage!) : null}
						onSteer={handleSteer}
						onInterrupt={handleInterrupt}
						onEdit={handleSubmit}
						dimAfterSequence={transcriptMode === 'canonical' ? scrubCursor : null}
						{pendingApproval}
						{approvalResolution}
						onResolveApproval={resolveSessionApproval}
					/>
				</div>
			</section>

			{#if inspector}
				<div class="run-slot">
					<RunPane
						{sessionKey}
						{inspector}
						running={runActive}
						hasPendingApproval={pendingApproval !== null}
						cursor={scrubCursor}
						onScrub={(cursor) => (scrubCursor = cursor)}
						onInterrupt={handleInterrupt}
					/>
				</div>
			{/if}
		</div>

		<SessionPhoneSurfaces
			{sessionKey}
			{currentUserMessage}
			{inspector}
			running={runActive}
			{pendingApproval}
			onResolveApproval={resolveSessionApproval}
		/>
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
		/* Preserve line breaks from multi-line remediation messages. */
		white-space: pre-line;
		flex: none;
	}

	.spacer {
		flex: 1;
	}

	/* ── Session strip ── */

	.session-strip {
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
		min-width: 0;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--cinder-text-subtle);
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		text-decoration: none;
		padding: 4px 6px;
		border-radius: var(--cinder-radius-sm);
		white-space: nowrap;
	}

	.back-link:hover {
		background: var(--cinder-surface-hover);
		color: var(--cinder-text);
	}

	.strip-divider {
		width: 1px;
		height: 18px;
		background: var(--cinder-border-muted);
	}

	.strip-title {
		margin: 0;
		font-size: 14.5px;
		font-weight: 650;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.strip-meta {
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
	}

	.strip-temporal {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-inset);
		color: var(--cinder-text);
		font-size: var(--cinder-text-xs);
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}

	.strip-temporal:hover {
		border-color: var(--cinder-accent);
		color: var(--cinder-accent-text);
	}

	/* ── Split surface ── */

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

	.pane-title {
		font-size: var(--cinder-text-sm);
		font-weight: 600;
		color: var(--cinder-text);
	}

	.pane-meta {
		font-family: var(--cinder-font-mono);
		font-size: 11px;
		font-weight: 500;
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

	.steer-strip {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 14px;
		border-bottom: 1px solid var(--cinder-border-muted);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--cinder-text-subtle);
	}

	.chat-area {
		flex: 1;
		overflow: hidden;
		background: var(--cinder-bg);
		padding: 0 28px;
	}

	.run-slot {
		width: 560px;
		flex: none;
		overflow: hidden;
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

	@media (max-width: 1024px) {
		.tablet-bar {
			display: flex;
		}

		.run-slot {
			width: 100%;
		}

		/* Desktop-only chrome hidden on tablet */
		.pane-header {
			display: none;
		}

		/* Default tablet state: show conversation, hide the run pane */
		.split-surface .run-slot {
			display: none;
		}

		.split-surface.tablet-show-run .conversation-pane {
			display: none;
		}

		.split-surface.tablet-show-run .run-slot {
			display: block;
		}
	}

	@media (max-width: 640px) {
		/* Hide desktop/tablet UI entirely; phone surfaces render instead */
		.tablet-bar,
		.split-surface,
		.session-strip {
			display: none;
		}
	}
</style>
