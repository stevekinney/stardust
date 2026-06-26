import { describe, expect, it } from 'vitest';
import { registeredTools } from '../tools/registry';
import {
	assertSideEffectAllowed,
	filterToolManifest,
	truncateToolOutput,
	validateToolCall
} from './policy-engine';

describe('policy engine', () => {
	it('filters manifest entries by allowlist', () => {
		expect(filterToolManifest(registeredTools, { allowedToolNames: ['web.fetch'] })).toHaveLength(
			1
		);
		expect(filterToolManifest(registeredTools, { allowedToolNames: ['web.fetch'] })[0]?.name).toBe(
			'web.fetch'
		);
	});

	it('allows safe calls and gates side effects', () => {
		expect(
			validateToolCall(registeredTools, {
				id: 'call-001',
				name: 'web.fetch',
				arguments: { url: 'https://example.test' }
			})
		).toMatchObject({ status: 'allowed' });
		const writeDecision = validateToolCall(registeredTools, {
			id: 'call-002',
			name: 'workspace.writeFile',
			arguments: { path: 'hello.txt', content: 'hello' }
		});
		expect(writeDecision).toMatchObject({ status: 'approval_required' });
		if (writeDecision.status === 'approval_required') {
			expect(assertSideEffectAllowed(writeDecision.tool.metadata)).toBe('approval_required');
		}
	});

	it('routes process and snapshot tools through approval policy', () => {
		for (const call of [
			{
				id: 'call-process-start',
				name: 'process.start',
				arguments: { command: 'bun', args: ['--version'] }
			},
			{
				id: 'call-process-kill',
				name: 'process.kill',
				arguments: { processId: 'process-001' }
			},
			{
				id: 'call-sandbox-snapshot',
				name: 'sandbox.snapshot',
				arguments: { label: 'before-edit' }
			}
		]) {
			const decision = validateToolCall(registeredTools, call);
			expect(decision).toMatchObject({ status: 'approval_required' });
			if (decision.status === 'approval_required') {
				expect(assertSideEffectAllowed(decision.tool.metadata)).toBe('approval_required');
			}
		}
	});

	it('rejects unknown and malformed calls', () => {
		expect(
			validateToolCall(registeredTools, { id: 'call-003', name: 'unknown.tool', arguments: {} })
		).toMatchObject({ status: 'denied', reason: 'Unknown tool: unknown.tool' });
		expect(
			validateToolCall(registeredTools, {
				id: 'call-004',
				name: 'web.fetch',
				arguments: { url: 'not-a-url' }
			})
		).toMatchObject({ status: 'denied' });
	});

	it('truncates large output while preserving head and tail', () => {
		const result = truncateToolOutput({
			callId: 'call-005',
			toolName: 'shell.exec',
			outcome: 'success',
			content: `${'HEAD'.repeat(1_250)}${'middle'.repeat(500)}${'TAIL'.repeat(1_250)}`
		});

		expect(result.metadata).toMatchObject({ truncated: true, originalCharacters: 13_000 });
		expect(result.content).toContain('[truncated');
		expect(result.content).toContain('HEAD');
		expect(result.content).toContain('TAIL');
	});
});
