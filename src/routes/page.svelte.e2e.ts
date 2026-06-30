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

function mockSessionRoutes(page: import('@playwright/test').Page) {
	return page.route('/api/sessions', (route) => {
		if (route.request().method() === 'POST') {
			void route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ sessionKey: 'e2e-mint-test-key' })
			});
		} else {
			void route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ sessions: [] })
			});
		}
	});
}

test('home page shows welcome screen when there are no sessions', async ({ page }) => {
	await mockSessionRoutes(page);

	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'What should the agent work on?' })).toBeVisible();
	await expect(page.getByLabel('Session navigation')).toBeVisible();
	await expect(page.getByLabel('Describe a task')).toBeVisible();
});

test('create → submit → stream: navigates to a conversation and renders the stream', async ({
	page
}) => {
	await page.route('/api/sessions', (route) => {
		if (route.request().method() === 'POST') {
			void route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ sessionKey: 'e2e-stream-session' })
			});
		} else {
			void route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ sessions: [] })
			});
		}
	});

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

	const messageInput = page.getByLabel('Describe a task');
	await messageInput.fill('Summarize climate change');
	await page.getByRole('button', { name: 'Start session' }).click();

	await page.waitForURL(/\/sessions\//);
	// Scope content assertions to the chat region: the responsive phone-monitor
	// surface (display:none at desktop width) carries the same session text in the DOM,
	// so an unscoped getByText matches two elements under Playwright strict mode.
	const chat = page.getByLabel('Chat conversation');
	await expect(chat).toBeVisible();

	await expect(chat.getByText('Summarize climate change')).toBeVisible({ timeout: 5_000 });

	await expect(
		chat.getByText('Climate change is a long-term shift in global temperatures.')
	).toBeVisible({ timeout: 10_000 });

	await expect(chat.getByLabel('Run complete')).toBeVisible({ timeout: 10_000 });
});

test('home page shows the session list when sessions exist', async ({ page }) => {
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				sessions: [
					{
						id: 'sess-001',
						sessionKey: 'my-test-session',
						name: 'Refactor auth guards',
						status: 'idle',
						workflowId: 'agent-session:my-test-session',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				]
			})
		});
	});

	await page.goto('/');

	// Scope to <main>: the same session also appears in the left rail, so an unscoped
	// getByText matches both the rail card and the main session card.
	const main = page.getByRole('main');
	await expect(main.getByText('Refactor auth guards')).toBeVisible();
	await expect(main.getByRole('searchbox')).toBeVisible();
});

test('resume: navigating to an existing session rehydrates the conversation from transcript', async ({
	page
}) => {
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

	// Mock the runs endpoint.
	await page.route('/api/sessions/resume-session/runs', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ runs: [] })
		});
	});

	await page.goto('/sessions/resume-session');

	// Scope to the chat region (see note above): the responsive phone-monitor surface
	// mirrors the session/step text in the DOM, tripping strict-mode on bare getByText.
	const chat = page.getByLabel('Chat conversation');

	await expect(chat.getByText('What is the capital of France?')).toBeVisible({
		timeout: 5_000
	});

	await expect(chat.getByText('search_web')).toBeVisible({ timeout: 5_000 });

	await expect(chat.getByText('The capital of France is Paris.')).toBeVisible({
		timeout: 5_000
	});

	await expect(chat.getByLabel('Run complete')).toBeVisible({ timeout: 5_000 });
});
