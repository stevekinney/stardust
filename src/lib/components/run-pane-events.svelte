<script lang="ts">
	import EventStreamViewer from '@lostgradient/cinder/event-stream-viewer';
	import DurabilityRibbon from './durability-ribbon.svelte';
	import type { RunInspectorProjection } from '$lib/server/observability/projection';
	import { transcriptToViewerEvents } from '$lib/run-inspector-adapters';

	type Props = {
		inspector: RunInspectorProjection;
		running: boolean;
		/** Replay cursor. Null means live — show every durable event. */
		cursor: number | null;
	};

	let { inspector, running, cursor }: Props = $props();

	const events = $derived.by(() => {
		const all = transcriptToViewerEvents(inspector.transcript);
		if (cursor === null) return all;
		return all.filter((event) => (event.sequence ?? Number.POSITIVE_INFINITY) <= cursor);
	});
</script>

<div class="events">
	<DurabilityRibbon evidence={inspector.durabilityEvidence} compact />
	<EventStreamViewer
		{events}
		label="Temporal event history"
		connectionState={running ? 'connected' : undefined}
		followLatest={cursor === null && running}
	/>
	<p class="footnote">
		This is the same history Temporal Web shows — every decision the workflow made, in order. A
		worker that crashes replays these events to rebuild state; that is the whole durability trick.
	</p>
</div>

<style>
	.events {
		display: grid;
		gap: 10px;
	}

	.footnote {
		margin: 0;
		font-size: 11px;
		line-height: 1.55;
		color: var(--cinder-text-subtle);
	}
</style>
