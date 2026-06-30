import { describe, expect, it } from 'vitest';
import { mapTemporalHistoryEvent } from './history-enrichment';

describe('Temporal history enrichment', () => {
	it.each([
		['EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', 'workflow', 'Workflow started'],
		['EVENT_TYPE_ACTIVITY_TASK_SCHEDULED', 'activity', 'Activity scheduled'],
		['EVENT_TYPE_ACTIVITY_TASK_FAILED', 'retry', 'Activity failed'],
		['EVENT_TYPE_TIMER_STARTED', 'timer', 'Timer started'],
		['EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED', 'child-workflow', 'Child workflow completed'],
		['EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED', 'update', 'Update accepted'],
		['EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED', 'signal', 'Signal received'],
		[
			'EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW',
			'continue-as-new',
			'Workflow continued as new'
		]
	])('maps %s to %s', (eventType, concept, label) => {
		const summary = mapTemporalHistoryEvent({
			eventId: 12,
			eventType,
			eventTime: '2026-06-30T12:00:00.000Z'
		});

		expect(summary).toMatchObject({
			eventId: '12',
			eventType,
			concept,
			label,
			timestamp: '2026-06-30T12:00:00.000Z'
		});
	});

	it('extracts activity attempt and task queue evidence when Temporal attributes are present', () => {
		const summary = mapTemporalHistoryEvent({
			eventId: 3,
			eventType: 'EVENT_TYPE_ACTIVITY_TASK_STARTED',
			activityTaskStartedEventAttributes: {
				attempt: 2,
				taskQueue: { name: 'tools-sandbox' }
			}
		});

		expect(summary.attempt).toBe(2);
		expect(summary.taskQueue).toBe('tools-sandbox');
	});
});
