import { expect, test } from '@playwright/test';

/**
 * Encode an SSE stream as a string of frames for mocking the stream endpoint.
 * Each frame is `id: N\nevent: kind\ndata: payload\n\n`.
 */
function sseBody(frames: Array<{ id: number; kind: string; data: object }>): string {
	return frames
		.map(({ id, kind, data }) => `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
		.join('');
}

test('home page shows welcome screen when there are no sessions', async ({ page }) => {
	// Intercept the sessions list so the test does not need a running database.
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ sessions: [] })
		});
	});

	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'What can I help you with?' })).toBeVisible();
	await expect(page.getByLabel('Session navigation')).toBeVisible();
	await expect(page.getByLabel('Message composer')).toBeVisible();
});

test('create → submit → stream: navigates to a conversation and renders the stream', async ({
	page
}) => {
	// Return empty sessions so the home page stays visible instead of redirecting.
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ sessions: [] })
		});
	});

	// Intercept the turn endpoint for any session key.
	await page.route(/\/api\/sessions\/[^/]+\/turn$/, (route) => {
		const urlParts = new URL(route.request().url()).pathname.split('/');
		const sessionKey = urlParts[3];
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				accepted: true,
				runId: 'run-001',
				streamUrl: `/api/sessions/${sessionKey}/stream/run-001`
			})
		});
	});

	// Mock the SSE stream endpoint with deterministic events.
	await page.route(/\/api\/sessions\/[^/]+\/stream\/run-001$/, (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'text/event-stream; charset=utf-8',
			headers: {
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive'
			},
			body: sseBody([
				{ id: 1, kind: 'lifecycle', data: { status: 'started' } },
				{
					id: 2,
					kind: 'assistant.delta',
					data: { text: 'Climate change is a long-term shift in global temperatures.' }
				},
				{ id: 3, kind: 'lifecycle', data: { status: 'complete' } }
			])
		});
	});

	await page.goto('/');

	// Type a message in the home page composer (use role=textbox to disambiguate).
	const messageInput = page.getByRole('textbox', { name: 'Message' });
	await messageInput.fill('Summarize climate change');
	await page.getByRole('button', { name: 'Send message' }).click();

	// Should navigate to a session conversation view.
	await page.waitForURL(/\/sessions\//);
	await expect(page.getByLabel('Message stream')).toBeVisible();

	// The user's message should appear.
	await expect(page.getByLabel('User message')).toContainText('Summarize climate change');

	// The assistant response should render from the SSE stream.
	await expect(page.getByLabel('Assistant message')).toContainText(
		'Climate change is a long-term shift in global temperatures.',
		{ timeout: 10_000 }
	);

	// The lifecycle complete marker should appear.
	await expect(page.getByLabel('Run complete')).toBeVisible({ timeout: 10_000 });
});

test('home page redirects to the most recent session when sessions exist', async ({ page }) => {
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				sessions: [
					{
						id: 'sess-001',
						sessionKey: 'my-test-session',
						status: 'idle',
						workflowId: 'agent-session:my-test-session',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				]
			})
		});
	});

	// Provide a minimal transcript so the redirect destination renders correctly.
	await page.route('/api/sessions/my-test-session/transcript', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] })
		});
	});

	await page.goto('/');

	// Should auto-redirect to the most recent session.
	await page.waitForURL('/sessions/my-test-session');
	await expect(page.getByLabel('Message stream')).toBeVisible();
	await expect(page.getByLabel('Message composer')).toBeVisible();
});

test('resume: navigating to an existing session rehydrates the conversation from transcript', async ({
	page
}) => {
	// Serve the session in the list so the page doesn't redirect away.
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				sessions: [
					{
						id: 'sess-002',
						sessionKey: 'resume-session',
						status: 'idle',
						workflowId: 'agent-session:resume-session',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				]
			})
		});
	});

	// Mock the transcript with real payload shapes matching what the server writes:
	// - user_message: { text } (observability.activities.ts → recordRunStarted)
	// - tool_call:    { calls: [{id, name, input}] } (model-runner.ts → appendTranscriptEvent)
	// - tool_result:  { callId, content, isError } (stream/index.ts → persistToolResult)
	// - assistant_message: { text } (observability.activities.ts → recordRunCompleted)
	// - lifecycle:    { status } (observability.activities.ts → recordRunStarted/recordRunCompleted)
	await page.route('/api/sessions/resume-session/transcript', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				events: [
					{
						id: 'evt-1',
						kind: 'user_message',
						payload: JSON.stringify({ text: 'What is the capital of France?' }),
						sequence: 1
					},
					{
						id: 'evt-2',
						kind: 'lifecycle',
						payload: JSON.stringify({ status: 'started', recoverySafe: true }),
						sequence: 2
					},
					{
						id: 'evt-3',
						kind: 'tool_call',
						payload: JSON.stringify({
							calls: [{ id: 'call-001', name: 'search_web', input: { query: 'capital France' } }]
						}),
						sequence: 3
					},
					{
						id: 'evt-4',
						kind: 'tool_result',
						payload: JSON.stringify({ callId: 'call-001', content: 'Paris', isError: false }),
						sequence: 4
					},
					{
						id: 'evt-5',
						kind: 'assistant_message',
						payload: JSON.stringify({ text: 'The capital of France is Paris.' }),
						sequence: 5
					},
					{
						id: 'evt-6',
						kind: 'lifecycle',
						payload: JSON.stringify({ status: 'complete', recoverySafe: true }),
						sequence: 6
					}
				]
			})
		});
	});

	await page.goto('/sessions/resume-session');

	// The user message should appear as the conversation header.
	await expect(page.getByLabel('User message')).toContainText('What is the capital of France?', {
		timeout: 5_000
	});

	// The tool card from the transcript should render.
	await expect(page.getByLabel('Tool: search_web')).toBeVisible({ timeout: 5_000 });

	// The assistant response from the transcript should render.
	await expect(page.getByLabel('Assistant message')).toContainText(
		'The capital of France is Paris.',
		{ timeout: 5_000 }
	);

	// The lifecycle completion marker should render.
	await expect(page.getByLabel('Run complete')).toBeVisible({ timeout: 5_000 });
});
