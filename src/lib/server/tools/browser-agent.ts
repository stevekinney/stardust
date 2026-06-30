import type { Page } from 'playwright';
import type { ArtifactStore } from '../artifacts/artifact-store';
import type { DatabaseClient } from '../db/client';
import { persistToolArtifact } from './artifact-output';

export type BrowserAction =
	| { type: 'goto'; url: string }
	| { type: 'click'; selector: string }
	| { type: 'fill'; selector: string; value: string }
	| { type: 'press'; selector: string; key: string }
	| { type: 'waitForSelector'; selector: string; timeoutMs?: number }
	| {
			type: 'waitForLoadState';
			state?: 'load' | 'domcontentloaded' | 'networkidle';
			timeoutMs?: number;
	  };

type BrowserAgentInput = {
	url: string;
	actions?: BrowserAction[];
	sessionId?: string;
	sessionKey?: string;
	runId?: string;
	toolCallId: string;
	artifactStore?: ArtifactStore;
	database?: DatabaseClient;
};

export async function inspectBrowser(input: BrowserAgentInput) {
	return runBrowserAgent(input);
}

export async function actInBrowser(input: BrowserAgentInput) {
	return runBrowserAgent(input);
}

async function runBrowserAgent(input: BrowserAgentInput) {
	const { chromium } = await import(/* @vite-ignore */ 'playwright');
	const browser = await chromium.launch({ headless: true });
	const consoleMessages: Array<{ type: string; text: string }> = [];
	const pageErrors: string[] = [];
	const failedRequests: Array<{ url: string; failure: string | null }> = [];

	try {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		const page = await context.newPage();
		page.on('console', (message) => {
			consoleMessages.push({ type: message.type(), text: message.text() });
		});
		page.on('pageerror', (error) => {
			pageErrors.push(error.message);
		});
		page.on('requestfailed', (request) => {
			failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? null });
		});

		await page.goto(input.url, { waitUntil: 'domcontentloaded' });
		for (const action of input.actions ?? []) {
			await runBrowserAction(page, action);
		}

		const title = await page.title();
		const url = page.url();
		const ariaSnapshot = await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5_000 });
		const screenshot = await page.screenshot({ fullPage: true });
		const screenshotArtifact =
			input.artifactStore && input.sessionId && input.sessionKey && input.runId
				? await persistToolArtifact({
						sessionId: input.sessionId,
						sessionKey: input.sessionKey,
						runId: input.runId,
						toolCallId: input.toolCallId,
						artifactStore: input.artifactStore,
						database: input.database,
						content: screenshot,
						mimeType: 'image/png',
						extension: 'png'
					})
				: null;

		return {
			url,
			title,
			actions: input.actions ?? [],
			consoleMessages,
			pageErrors,
			failedRequests,
			ariaSnapshot,
			screenshotArtifact
		};
	} finally {
		await browser.close();
	}
}

async function runBrowserAction(page: Page, action: BrowserAction) {
	if (action.type === 'goto') {
		await page.goto(action.url, { waitUntil: 'domcontentloaded' });
	} else if (action.type === 'click') {
		await page.locator(action.selector).click();
	} else if (action.type === 'fill') {
		await page.locator(action.selector).fill(action.value);
	} else if (action.type === 'press') {
		await page.locator(action.selector).press(action.key);
	} else if (action.type === 'waitForSelector') {
		await page.locator(action.selector).waitFor({ timeout: action.timeoutMs ?? 5_000 });
	} else {
		await page.waitForLoadState(action.state ?? 'load', { timeout: action.timeoutMs ?? 10_000 });
	}
}
