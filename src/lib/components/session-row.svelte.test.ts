import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SessionRow from './session-row.svelte';
import type { SessionRow as SessionRowData } from '$lib/types';

function makeSession(overrides: Partial<SessionRowData> = {}): SessionRowData {
	return {
		id: 'sess-1',
		sessionKey: 'demo-seed-mr2hx0la',
		status: 'active',
		workflowId: 'agent-session:demo-seed-mr2hx0la',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		name: 'Demonstrate Temporal durability',
		temporalWebUrl:
			'http://localhost:8233/namespaces/default/workflows/agent-session%3Ademo-seed-mr2hx0la',
		...overrides
	};
}

describe('SessionRow', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	// Regression: the workflow-key link had no truncation floor, so at narrow
	// widths the flex layout squeezed the session title down to a couple of
	// characters instead of shrinking the link. The link's session-key text
	// now lives in its own `.wf-chip-key` span (hidden below phone width via
	// CSS) with the full key preserved as an always-present aria-label, so
	// the link stays identifiable to assistive tech regardless of what's
	// visually shown.
	it('renders the workflow link with a stable label independent of the visible key text', () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {} }
		});

		const link = document.querySelector('a.wf-chip');
		expect(link).not.toBeNull();
		expect(link!.getAttribute('aria-label')).toBe('Open demo-seed-mr2hx0la in Temporal Web');
		expect(link!.querySelector('.wf-chip-key')?.textContent).toBe('demo-seed-mr2hx0la');
		expect(link!.getAttribute('href')).toBe(makeSession().temporalWebUrl);

		unmount(component);
	});

	it('omits the workflow link when there is no Temporal Web URL', () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession({ temporalWebUrl: undefined }), onOpen: () => {} }
		});

		expect(document.querySelector('a.wf-chip')).toBeNull();

		unmount(component);
	});
});
