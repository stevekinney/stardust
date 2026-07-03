import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleTimeline from './schedule-timeline.svelte';
import type { ScheduleProjection } from '$lib/types';

function makeSchedule(overrides: Partial<ScheduleProjection> = {}): ScheduleProjection {
	return {
		id: 'sched-1',
		temporalScheduleId: 'schedule-sched-1',
		targetSessionKey: 'session-1',
		name: 'morning-digest',
		description: null,
		cronExpression: '0 6 * * *',
		prompt: 'Run the morning digest',
		status: 'active',
		lastRunAt: null,
		nextRunAt: null,
		fireEvents: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}

describe('ScheduleTimeline', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	// Regression: the "now" marker rendered unconditionally and overlapped the
	// "No fires in the next 24 hours" empty-state text — both are absolutely
	// positioned in the same vertical band with nothing to keep them apart
	// when there's nothing else on the track.
	it('hides the now marker and shows the empty message when there are no fires', () => {
		const component = mount(ScheduleTimeline, {
			target: document.body,
			props: { schedules: [makeSchedule()] }
		});

		expect(document.querySelector('.now-marker')).toBeNull();
		expect(document.querySelector('.track-empty')?.textContent).toBe(
			'No fires in the next 24 hours.'
		);

		unmount(component);
	});

	it('shows the now marker alongside upcoming and fired events', () => {
		const component = mount(ScheduleTimeline, {
			target: document.body,
			props: {
				schedules: [
					makeSchedule({
						nextRunAt: '2026-07-03T18:00:00.000Z',
						fireEvents: [
							{
								id: 'fire-1',
								scheduleId: 'sched-1',
								triggerSource: 'scheduled',
								scheduledTime: '2026-07-03T09:00:00.000Z',
								actualTriggerTime: '2026-07-03T09:00:00.000Z',
								overlapPolicy: 'skip',
								scheduledWorkflowId: null,
								scheduledTemporalRunId: null,
								targetSessionKey: 'session-1',
								acceptedRunId: null,
								status: 'accepted',
								error: null
							}
						]
					})
				]
			}
		});

		expect(document.querySelector('.now-marker')).not.toBeNull();
		expect(document.querySelector('.track-empty')).toBeNull();
		expect(document.querySelectorAll('.fire')).toHaveLength(2);

		unmount(component);
	});
});
