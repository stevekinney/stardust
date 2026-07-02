import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HealthPopover from './health-popover.svelte';
import type { HealthSnapshot } from '$lib/types';

const snapshot: HealthSnapshot = {
	address: 'localhost:7233',
	namespace: 'default',
	reachable: true,
	workerCount: 1,
	taskQueues: [
		{ name: 'agent-orchestrator', healthy: true },
		{ name: 'tools-general', healthy: false }
	],
	spendTodayUsd: 0.47,
	tokensToday: 182_000,
	temporalWebUrl: 'http://localhost:8233'
};

describe('HealthPopover', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the cluster trigger with worker count and spend when healthy', () => {
		const component = mount(HealthPopover, {
			target: document.body,
			props: { health: snapshot }
		});

		const trigger = document.querySelector('button.cluster');
		expect(trigger).not.toBeNull();
		expect(trigger!.textContent).toContain('temporal :7233');
		expect(trigger!.textContent).toContain('1 worker');
		expect(trigger!.textContent).toContain('$0.47 today');

		unmount(component);
	});

	it('opens the panel with queue health, spend, and Temporal Web links', async () => {
		const component = mount(HealthPopover, {
			target: document.body,
			props: { health: snapshot }
		});

		(document.querySelector('button.cluster') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

		const panel = document.querySelector('[role="dialog"]');
		expect(panel!.textContent).toContain('Everything durable');
		expect(panel!.textContent).toContain('agent-orchestrator ✓');
		expect(panel!.textContent).toContain('tools-general ✕');
		expect(panel!.textContent).toContain('182k tokens');

		const link = panel!.querySelector('a.link-primary');
		expect(link?.getAttribute('href')).toBe('http://localhost:8233');

		unmount(component);
	});

	it('shows unreachable state without crashing when health is degraded', () => {
		const component = mount(HealthPopover, {
			target: document.body,
			props: { health: { ...snapshot, reachable: false, workerCount: null, taskQueues: [] } }
		});

		const trigger = document.querySelector('button.cluster');
		expect(trigger!.textContent).toContain('temporal :7233');
		expect(trigger!.textContent).not.toContain('worker');

		unmount(component);
	});
});
