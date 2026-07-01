import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { BROWSER_MCP_TOOL } from '../policy/risk';
import type { RegisteredTool } from '../policy/policy-engine';
import { defineStardustTool } from './define-tool';

const require = createRequire(import.meta.url);

/**
 * Allowlisted Playwright MCP tools: core page interaction (navigate, click, type,
 * keyboard/mouse, tabs, dialogs) and observation (snapshot, screenshot, console,
 * network, verify) tools only.
 *
 * Excluded on purpose:
 * - Filesystem-touching tools: `browser_file_upload`, `browser_drop` (reads local
 *   paths), `browser_pdf_save`, `browser_set_storage_state`/`browser_storage_state`,
 *   tracing (`browser_start_tracing`/`browser_stop_tracing`) and video
 *   (`browser_start_video`/`browser_stop_video`/`browser_video_*`) tools, all of
 *   which read or write files under the MCP server's output directory.
 * - Arbitrary code execution: `browser_evaluate` and `browser_run_code_unsafe` (the
 *   latter's own description calls it "RCE-equivalent").
 * - Sensitive state access: cookies, localStorage, sessionStorage, and network
 *   route mocking (`browser_route`/`browser_unroute`/`browser_network_state_set`).
 */
const ALLOWED_TOOL_NAMES = new Set([
	// Interaction
	'browser_click',
	'browser_close',
	'browser_drag',
	'browser_fill_form',
	'browser_handle_dialog',
	'browser_hover',
	'browser_navigate',
	'browser_navigate_back',
	'browser_press_key',
	'browser_resize',
	'browser_resume',
	'browser_select_option',
	'browser_type',
	'browser_wait_for',
	'browser_tabs',
	'browser_mouse_click_xy',
	'browser_mouse_down',
	'browser_mouse_drag_xy',
	'browser_mouse_move_xy',
	'browser_mouse_up',
	'browser_mouse_wheel',
	// Observation
	'browser_snapshot',
	'browser_take_screenshot',
	'browser_console_messages',
	'browser_network_request',
	'browser_network_requests',
	'browser_get_config',
	'browser_generate_locator',
	'browser_highlight',
	'browser_hide_highlight',
	'browser_annotate',
	'browser_verify_element_visible',
	'browser_verify_list_visible',
	'browser_verify_text_visible',
	'browser_verify_value'
]);

type PlaywrightMcpClientLike = {
	callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
};

const playwrightMcpCallInput = z.object({
	toolName: z.string().min(1).refine(isPlaywrightMcpToolAllowed, {
		message: 'Playwright MCP tool is not exposed by Stardust policy'
	}),
	arguments: z.record(z.string(), z.unknown()).default({})
});

let cachedClient: PlaywrightMcpClientLike | null = null;

/** Returns true when `toolName` is one of the allowlisted Playwright MCP tools. */
export function isPlaywrightMcpToolAllowed(toolName: string): boolean {
	return ALLOWED_TOOL_NAMES.has(toolName);
}

/** Calls an allowlisted Playwright MCP tool through the bundled `@playwright/mcp` server. */
export async function callPlaywrightMcpTool(input: {
	toolName: string;
	arguments: Record<string, unknown>;
	client?: PlaywrightMcpClientLike;
}) {
	if (!isPlaywrightMcpToolAllowed(input.toolName)) {
		throw new Error(`Playwright MCP tool is not allowed: ${input.toolName}`);
	}
	const client = input.client ?? (await getPlaywrightMcpClient());
	return normalizeMcpResult(
		await client.callTool({ name: input.toolName, arguments: input.arguments })
	);
}

/** Builds the `browser.mcp.call` registered tool definition. */
export function definePlaywrightMcpTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'browser.mcp.call',
			description:
				'Drive a headless, ephemeral Playwright browser through the bundled Playwright MCP server. ' +
				'Supports core interaction tools (browser_navigate, browser_click, browser_type, ' +
				'browser_press_key, browser_select_option, browser_tabs) and observation tools ' +
				'(browser_snapshot, browser_take_screenshot, browser_wait_for, browser_console_messages).',
			schema: playwrightMcpCallInput,
			metadata: BROWSER_MCP_TOOL
		})
	];
}

async function getPlaywrightMcpClient(): Promise<PlaywrightMcpClientLike> {
	if (cachedClient) return cachedClient;
	const client = new Client({ name: 'stardust-playwright-mcp-client', version: '0.0.1' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [resolvePlaywrightMcpCliPath(), '--headless', '--isolated'],
			stderr: 'pipe'
		})
	);
	cachedClient = client;
	return client;
}

/**
 * Resolves the absolute path to the `@playwright/mcp` CLI entry point.
 *
 * The package's `exports` map only exposes `.` (the library API) and
 * `./package.json`, so `require.resolve('@playwright/mcp/cli.js')` fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Instead we resolve `package.json` (which is
 * exported) and read its `bin` field to find the real CLI file on disk.
 */
function resolvePlaywrightMcpCliPath(): string {
	const packageJsonPath = require.resolve('@playwright/mcp/package.json');
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
		bin?: Record<string, string> | string;
	};
	const relativeBinPath =
		typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['playwright-mcp'];
	if (!relativeBinPath) {
		throw new Error(
			'Could not resolve the @playwright/mcp CLI entry: no "bin" field found in its package.json'
		);
	}
	return join(dirname(packageJsonPath), relativeBinPath);
}

function normalizeMcpResult(result: unknown) {
	if (!result || typeof result !== 'object') return result;
	const record = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
	if (record.structuredContent !== undefined) return record.structuredContent;
	if (!Array.isArray(record.content)) return result;
	return {
		isError: record.isError === true,
		content: record.content.map((item) => {
			if (!item || typeof item !== 'object') return item;
			const block = item as Record<string, unknown>;
			if (block.type === 'text' && typeof block.text === 'string') {
				try {
					return JSON.parse(block.text) as unknown;
				} catch {
					return block.text;
				}
			}
			return block;
		})
	};
}
