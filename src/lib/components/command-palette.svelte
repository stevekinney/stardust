<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CommandPalette from '@lostgradient/cinder/command-palette';
	import CommandItem from '@lostgradient/cinder/command-item';
	import Kbd from '@lostgradient/cinder/kbd';
	import { inbox } from '$lib/inbox.svelte';
	import { sessionsStore } from '$lib/sessions.svelte';
	import { displayLabel, statusDotClass } from '$lib/session-display';
	import type { HealthSnapshot, ScheduleProjection } from '$lib/types';

	type Props = {
		open: boolean;
		health?: HealthSnapshot | null;
	};

	let { open = $bindable(false), health = null }: Props = $props();

	let schedules = $state.raw<ScheduleProjection[]>([]);

	const temporalWebUrl = $derived(health?.temporalWebUrl ?? 'http://localhost:8233');

	$effect(() => {
		if (!open) return;
		void sessionsStore.ensureLoaded();
		void loadSchedules();
	});

	async function loadSchedules() {
		try {
			const response = await fetch('/api/schedules');
			if (!response.ok) return;
			const body = (await response.json()) as { schedules: ScheduleProjection[] };
			schedules = body.schedules;
		} catch {
			// Non-fatal — the group simply stays empty
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			open = !open;
		}
	}

	function matches(query: string, label: string): boolean {
		return label.toLowerCase().includes(query.trim().toLowerCase());
	}

	function run(action: () => void) {
		open = false;
		action();
	}

	async function newSession() {
		const response = await fetch('/api/sessions', { method: 'POST' });
		if (!response.ok) return;
		const body = (await response.json()) as { sessionKey: string };
		void goto(resolve(`/sessions/${encodeURIComponent(body.sessionKey)}`));
	}

	async function triggerSchedule(schedule: ScheduleProjection) {
		await fetch(`/api/schedules/${schedule.temporalScheduleId}/trigger`, { method: 'POST' });
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<CommandPalette bind:open label="Command palette" placeholder="Type a command or search sessions…">
	{#snippet items({ query }: { query: string })}
		{#if matches(query, 'New session')}
			<CommandItem value="new-session" onselect={() => run(() => void newSession())}>
				New session
			</CommandItem>
		{/if}
		{#if inbox.pendingApprovals.length > 0 && matches(query, 'Review pending approvals inbox')}
			<CommandItem
				value="review-approvals"
				description="{inbox.pendingApprovals.length} waiting in the inbox"
				onselect={() => run(() => void goto(resolve('/inbox')))}
			>
				Review pending approvals
				{#snippet trailing()}
					<Kbd label="inbox" size="sm" />
				{/snippet}
			</CommandItem>
		{/if}
		{#each schedules.filter((schedule) => schedule.status === 'active' && matches(query, `Trigger schedule ${schedule.name}`)) as schedule (schedule.id)}
			<CommandItem
				value="trigger-{schedule.id}"
				onselect={() => run(() => void triggerSchedule(schedule))}
			>
				Trigger schedule: {schedule.name}
				{#snippet trailing()}
					<Kbd label="schedules" size="sm" />
				{/snippet}
			</CommandItem>
		{/each}

		{#each sessionsStore.active.filter( (session) => matches(query, `${displayLabel(session)} ${session.sessionKey}`) ) as session (session.id)}
			<CommandItem
				value="session-{session.sessionKey}"
				accessibleLabel="Open session {displayLabel(session)}"
				onselect={() =>
					run(() => void goto(resolve(`/sessions/${encodeURIComponent(session.sessionKey)}`)))}
			>
				{#snippet leading()}
					<span class="dot {statusDotClass(session.status)}"></span>
				{/snippet}
				{displayLabel(session)}
				{#snippet trailing()}
					<span class="hint">{session.sessionKey}</span>
				{/snippet}
			</CommandItem>
		{/each}

		{#if matches(query, 'Open Temporal Web')}
			<CommandItem
				value="temporal-web"
				onselect={() => run(() => window.open(temporalWebUrl, '_blank', 'noreferrer'))}
			>
				Open Temporal Web
				{#snippet trailing()}
					<span class="hint">↗</span>
				{/snippet}
			</CommandItem>
		{/if}
		{#if matches(query, 'Open task queue agent-orchestrator')}
			<CommandItem
				value="task-queue"
				onselect={() =>
					run(() =>
						window.open(
							`${temporalWebUrl}/namespaces/${health?.namespace ?? 'default'}/task-queues/agent-orchestrator`,
							'_blank',
							'noreferrer'
						)
					)}
			>
				Open task queue agent-orchestrator
				{#snippet trailing()}
					<span class="hint">↗</span>
				{/snippet}
			</CommandItem>
		{/if}
	{/snippet}

	{#snippet empty()}
		<p class="empty">No matching commands or sessions.</p>
	{/snippet}

	{#snippet footer()}
		<div class="palette-footer">
			<span>↑↓ navigate</span>
			<span>⏎ run</span>
			<span>esc close</span>
			<span class="spacer"></span>
			<span class="mono">every action here is durable</span>
		</div>
	{/snippet}
</CommandPalette>

<style>
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}

	.dot-success {
		background: var(--cinder-success);
	}

	.dot-danger {
		background: var(--cinder-danger);
	}

	.dot-accent {
		background: var(--cinder-accent);
	}

	.dot-warning {
		background: var(--cinder-warning);
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

	.hint {
		font-family: var(--cinder-font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--cinder-text-disabled);
	}

	.empty {
		margin: 0;
		padding: 8px 10px;
		font-size: var(--cinder-text-sm);
		color: var(--cinder-text-subtle);
	}

	.palette-footer {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 10.5px;
		color: var(--cinder-text-disabled);
		width: 100%;
	}

	.spacer {
		flex: 1;
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}
</style>
