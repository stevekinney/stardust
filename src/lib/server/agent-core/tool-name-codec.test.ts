import { describe, expect, it } from 'vitest';
import { buildCanonicalToolNameIndex, fromModelToolName, toModelToolName } from './tool-name-codec';

const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

describe('toModelToolName', () => {
	it('replaces dots with a double underscore', () => {
		expect(toModelToolName('workspace.write')).toBe('workspace__write');
		expect(toModelToolName('browser.mcp.call')).toBe('browser__mcp__call');
	});

	it('never collides with Anthropic hosted server tool names', () => {
		// The hosted server tools are web_search / web_fetch; a custom web.fetch
		// must sanitize to something else or the API rejects the tools array as
		// non-unique.
		expect(toModelToolName('web.fetch')).not.toBe('web_fetch');
		expect(toModelToolName('web.search')).not.toBe('web_search');
	});

	it('leaves already-valid names unchanged', () => {
		expect(toModelToolName('run_command')).toBe('run_command');
		expect(toModelToolName('web-fetch')).toBe('web-fetch');
	});

	it('replaces any character outside the API pattern', () => {
		expect(toModelToolName('weird tool!name')).toBe('weird_tool_name');
	});

	it('caps the result at 128 characters', () => {
		expect(toModelToolName(`${'a'.repeat(200)}.tail`)).toHaveLength(128);
	});

	it('always produces names the Anthropic API accepts', () => {
		for (const name of ['workspace.write', 'memory.writeCandidate', 'db.query', 'notify.user']) {
			expect(toModelToolName(name)).toMatch(ANTHROPIC_TOOL_NAME_PATTERN);
		}
	});
});

describe('buildCanonicalToolNameIndex', () => {
	it('maps model-safe names back to canonical names', () => {
		const index = buildCanonicalToolNameIndex(['workspace.write', 'memory.search']);
		expect(fromModelToolName('workspace__write', index)).toBe('workspace.write');
		expect(fromModelToolName('memory__search', index)).toBe('memory.search');
	});

	it('passes unknown names through unchanged', () => {
		const index = buildCanonicalToolNameIndex(['workspace.write']);
		expect(fromModelToolName('web_search', index)).toBe('web_search');
	});

	it('throws when two canonical names collide after sanitizing', () => {
		expect(() => buildCanonicalToolNameIndex(['workspace.write', 'workspace__write'])).toThrow(
			/both sanitize to "workspace__write"/
		);
	});

	it('tolerates the same canonical name appearing twice', () => {
		expect(() => buildCanonicalToolNameIndex(['workspace.write', 'workspace.write'])).not.toThrow();
	});
});
