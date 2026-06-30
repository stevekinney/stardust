import { describe, expect, it } from 'vitest';
import {
	memoryTaskQueueActivities,
	modelTaskQueueActivities,
	sandboxTaskQueueActivities,
	toolsTaskQueueActivities
} from './main';

describe('worker task queue activity registration', () => {
	it('registers only model activities on the model task queue', () => {
		expect(Object.keys(modelTaskQueueActivities).sort()).toEqual(['callModel']);
	});

	it('registers only policy and observability activities on the tools task queue', () => {
		expect(Object.keys(toolsTaskQueueActivities).sort()).toEqual([
			'evaluateToolCallPolicy',
			'executeTool',
			'forwardApprovalToRun',
			'listToolManifest',
			'persistToolResult',
			'recordApprovalRequest',
			'recordApprovalResolution',
			'recordRunCompleted',
			'recordRunStarted',
			'recordSubagentCompleted',
			'recordSubagentStarted'
		]);
	});

	it('registers only sandbox and tool execution activities on the sandbox task queue', () => {
		expect(Object.keys(sandboxTaskQueueActivities).sort()).toEqual([
			'cancelSandboxSession',
			'ensureSandboxWorkspace',
			'executeTool',
			'killSandboxProcess',
			'readSandboxFile',
			'restoreSandbox',
			'runEphemeralSandboxCommand',
			'runSandboxCommand',
			'snapshotSandbox',
			'startSandboxProcess',
			'writeSandboxFile'
		]);
	});

	it('registers only memory and schedule submission activities on the memory task queue', () => {
		expect(Object.keys(memoryTaskQueueActivities).sort()).toEqual([
			'confirmMemoryCandidate',
			'executeTool',
			'generateEmbedding',
			'listMemoryNotes',
			'loadMemoryCompactionInput',
			'persistMemoryCompaction',
			'readMemoryNote',
			'searchMemory',
			'submitScheduledTurn',
			'summarizeMemoryCompaction',
			'writeMemoryCandidate'
		]);
	});
});
