import { describe, expect, it, vi } from 'vitest';
import { BROWSER_MCP_TOOL } from '../policy/risk';
import {
	callPlaywrightMcpTool,
	definePlaywrightMcpTools,
	isPlaywrightMcpToolAllowed
} from './playwright-mcp';

describe('isPlaywrightMcpToolAllowed', () => {
	it('allows core interaction and observation tools', () => {
		for (const toolName of [
			'browser_navigate',
			'browser_snapshot',
			'browser_click',
			'browser_type',
			'browser_take_screenshot',
			'browser_wait_for',
			'browser_press_key',
			'browser_select_option',
			'browser_tabs'
		]) {
			expect(isPlaywrightMcpToolAllowed(toolName)).toBe(true);
		}
	});

	it('denies filesystem, install, and arbitrary-code-execution tools', () => {
		for (const toolName of [
			'browser_file_upload',
			'browser_drop',
			'browser_pdf_save',
			'browser_set_storage_state',
			'browser_storage_state',
			'browser_start_tracing',
			'browser_start_video',
			'browser_evaluate',
			'browser_run_code_unsafe',
			'browser_cookie_list',
			'browser_localstorage_get',
			'install-browser',
			'unknown.tool'
		]) {
			expect(isPlaywrightMcpToolAllowed(toolName)).toBe(false);
		}
	});
});

describe('callPlaywrightMcpTool', () => {
	it('calls the injected client and normalizes text-block JSON content', async () => {
		const callTool = vi.fn(async () => ({
			content: [{ type: 'text', text: JSON.stringify({ url: 'https://example.test' }) }]
		}));

		const result = await callPlaywrightMcpTool({
			toolName: 'browser_navigate',
			arguments: { url: 'https://example.test' },
			client: { callTool }
		});

		expect(callTool).toHaveBeenCalledWith({
			name: 'browser_navigate',
			arguments: { url: 'https://example.test' }
		});
		expect(result).toEqual({
			isError: false,
			content: [{ url: 'https://example.test' }]
		});
	});

	it('prefers structuredContent when present', async () => {
		const callTool = vi.fn(async () => ({ structuredContent: { ok: true } }));

		const result = await callPlaywrightMcpTool({
			toolName: 'browser_snapshot',
			arguments: {},
			client: { callTool }
		});

		expect(result).toEqual({ ok: true });
	});

	it('rejects disallowed tools before ever calling the client', async () => {
		const callTool = vi.fn();

		await expect(
			callPlaywrightMcpTool({
				toolName: 'browser_run_code_unsafe',
				arguments: { code: 'process.exit(1)' },
				client: { callTool }
			})
		).rejects.toThrow('Playwright MCP tool is not allowed: browser_run_code_unsafe');

		expect(callTool).not.toHaveBeenCalled();
	});
});

describe('definePlaywrightMcpTools', () => {
	it('exposes a single browser.mcp.call tool backed by BROWSER_MCP_TOOL metadata', () => {
		const tools = definePlaywrightMcpTools();

		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: 'browser.mcp.call',
			metadata: BROWSER_MCP_TOOL
		});
	});

	it('validates toolName against the allowlist through the tool schema', () => {
		const [tool] = definePlaywrightMcpTools();

		expect(tool.schema.safeParse({ toolName: 'browser_click', arguments: {} }).success).toBe(true);
		expect(tool.schema.safeParse({ toolName: 'browser_evaluate', arguments: {} }).success).toBe(
			false
		);
		expect(tool.schema.safeParse({ toolName: 'browser_navigate' }).success).toBe(true);
	});
});
