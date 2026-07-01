import { z } from 'zod';
import type { RegisteredTool } from '../policy/policy-engine';
import {
	BROWSER_ACTION_TOOL,
	BROWSER_INSPECT_TOOL,
	DELEGATE_TOOL,
	LOW_RISK_TOOL,
	MEMORY_WRITE_CANDIDATE_TOOL,
	MUTATING_WORKSPACE_TOOL,
	PROCESS_KILL_TOOL,
	PROCESS_START_TOOL,
	REPOSITORY_INSPECT_TOOL,
	SAFE_ARTIFACT_TOOL,
	SANDBOX_RESTORE_TOOL,
	SANDBOX_SNAPSHOT_TOOL,
	SHELL_EXEC_TOOL,
	TEMPORAL_MCP_TOOL,
	VERIFICATION_TOOL
} from '../policy/risk';
import { defineStardustTool } from './define-tool';
import { isTemporalMcpToolAllowed } from './temporal-mcp';
import { defineTimerTools, defineSessionMessagingTools } from './timer-tool';
import { defineScheduleTools } from './schedule-tools';
import { definePublicDataTools } from './public-data';
import { defineLocalNotificationTools } from './local-notifications';
import { definePlaywrightMcpTools } from './playwright-mcp';
import { defineContext7Tools } from './context7';
import { defineScratchDbTools } from './scratch-db';

export const webFetchInput = z.object({
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).optional(),
	maxBytes: z.number().int().positive().max(256_000).optional()
});

export const pathInput = z.object({
	path: z.string().min(1)
});

export const writeFileInput = pathInput.extend({
	content: z.string()
});

/**
 * Input for `workspace.applyPatch`. The `patch` field must be a valid unified diff
 * (output of `diff -u` or `git diff`). The `path` field is the workspace-relative
 * target file path. The patch is applied with the system `patch` command.
 */
export const applyPatchInput = pathInput.extend({
	patch: z.string().min(1)
});

export const searchFilesInput = z.object({
	pattern: z.string().min(1),
	path: z.string().optional()
});

export const memorySearchInput = z.object({
	query: z.string().min(1),
	layers: z.array(z.enum(['session', 'durable', 'action-sensitive'])).optional(),
	limit: z.number().int().positive().max(20).default(10)
});

export const shellExecInput = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	timeoutMs: z.number().int().positive().max(30_000).optional()
});

export const processStartInput = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	workingDirectory: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().max(30_000).optional()
});

export const processKillInput = z.object({
	processId: z.string().min(1),
	signal: z.enum(['SIGTERM', 'SIGKILL']).default('SIGTERM')
});

export const sandboxSnapshotInput = z.object({
	label: z.string().min(1),
	description: z.string().optional()
});

export const workspaceDiffInput = z.object({
	base: z.string().min(1).optional(),
	head: z.string().min(1).optional(),
	path: z.string().min(1).optional(),
	contextLines: z.number().int().min(0).max(20).default(3)
});

export const sandboxRestoreInput = z.object({
	snapshotId: z.string().min(1),
	reason: z.string().min(1).optional()
});

export const verificationRunInput = z.object({
	check: z.enum(['format:check', 'lint', 'typecheck', 'test:unit', 'test:e2e', 'test', 'build']),
	args: z.array(z.string()).default([]),
	timeoutMs: z.number().int().positive().max(120_000).optional()
});

export const browserInspectInput = z.object({
	url: z.string().url(),
	waitForSelector: z.string().min(1).optional(),
	waitForLoadState: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
	includeScreenshot: z.boolean().default(true),
	includeAccessibilitySnapshot: z.boolean().default(true)
});

export const browserActionInput = browserInspectInput.extend({
	actions: z
		.array(
			z.discriminatedUnion('type', [
				z.object({ type: z.literal('goto'), url: z.string().url() }),
				z.object({ type: z.literal('click'), selector: z.string().min(1) }),
				z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
				z.object({ type: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
				z.object({ type: z.literal('waitForSelector'), selector: z.string().min(1) }),
				z.object({
					type: z.literal('waitForLoadState'),
					state: z.enum(['load', 'domcontentloaded', 'networkidle'])
				})
			])
		)
		.min(1)
		.max(20)
});

export const repositoryInspectInput = z.object({
	path: z.string().min(1).optional(),
	includePackageScripts: z.boolean().default(true),
	includeRoutes: z.boolean().default(true),
	includeTests: z.boolean().default(true),
	includeGitStatus: z.boolean().default(true)
});

export const temporalInspectInput = z.object({
	workflowId: z.string().min(1).optional(),
	runId: z.string().min(1).optional(),
	taskQueue: z.string().min(1).optional(),
	namespace: z.string().min(1).optional()
});

export const temporalMcpCallInput = z.object({
	toolName: z.string().min(1).refine(isTemporalMcpToolAllowed, {
		message: 'Temporal MCP tool is not exposed by Stardust policy'
	}),
	arguments: z.record(z.string(), z.unknown()).default({})
});

export const delegateParallelInput = z.object({
	tasks: z
		.array(
			z.object({
				kind: z.enum(['research', 'code', 'critic']),
				label: z.string().min(1),
				prompt: z.string().min(1),
				maxTokens: z.number().int().positive().max(8_000).optional()
			})
		)
		.min(2)
		.max(6)
});

export const reportArtifactInput = z.object({
	title: z.string().min(1),
	summary: z.string().min(1).optional(),
	sections: z
		.array(
			z.object({
				heading: z.string().min(1),
				body: z.string().min(1)
			})
		)
		.default([]),
	includeToolResults: z.boolean().default(true)
});

export const memoryWriteCandidateInput = z.object({
	layer: z.enum(['session', 'durable', 'action-sensitive']),
	content: z.string().min(1),
	rationale: z.string().optional(),
	expiresAt: z.string().datetime().optional()
});

export const delegateInput = z.object({
	prompt: z.string().min(1),
	maxTokens: z.number().int().positive().max(8_000).optional()
});

function defineCoreTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'web.fetch',
			description: 'Fetch an HTTP or HTTPS URL with SSRF protection.',
			schema: webFetchInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'workspace.readFile',
			description: 'Read a file from the current workspace.',
			schema: pathInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'workspace.writeFile',
			description: 'Write a file in the current workspace.',
			schema: writeFileInput,
			metadata: MUTATING_WORKSPACE_TOOL
		}),
		defineStardustTool({
			name: 'workspace.applyPatch',
			description:
				'Apply a unified diff patch (from `diff -u` or `git diff`) to a file in the current workspace. Requires approval because it modifies files.',
			schema: applyPatchInput,
			metadata: MUTATING_WORKSPACE_TOOL
		}),
		defineStardustTool({
			name: 'workspace.diff',
			description:
				'Generate a read-only git diff between sandbox snapshots, commits, or the working tree.',
			schema: workspaceDiffInput,
			metadata: REPOSITORY_INSPECT_TOOL
		}),
		defineStardustTool({
			name: 'shell.exec',
			description: 'Run a shell command in the current workspace.',
			schema: shellExecInput,
			metadata: SHELL_EXEC_TOOL
		})
	];
}

function defineExtendedTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'workspace.searchFiles',
			description: 'Search for files matching a glob pattern in the current workspace.',
			schema: searchFilesInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'memory.search',
			description: 'Search session memory using FTS5 lexical retrieval.',
			schema: memorySearchInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'process.start',
			description: 'Start a long-running process in the current sandbox workspace.',
			schema: processStartInput,
			metadata: PROCESS_START_TOOL
		}),
		defineStardustTool({
			name: 'process.kill',
			description: 'Terminate a tracked sandbox process.',
			schema: processKillInput,
			metadata: PROCESS_KILL_TOOL
		}),
		defineStardustTool({
			name: 'sandbox.snapshot',
			description: 'Create a named snapshot of the current sandbox workspace.',
			schema: sandboxSnapshotInput,
			metadata: SANDBOX_SNAPSHOT_TOOL
		}),
		defineStardustTool({
			name: 'sandbox.restore',
			description:
				'Restore the sandbox workspace to a previous snapshot commit. Requires approval.',
			schema: sandboxRestoreInput,
			metadata: SANDBOX_RESTORE_TOOL
		}),
		defineStardustTool({
			name: 'verification.run',
			description:
				'Run a structured verification command such as format:check, lint, typecheck, test, or build.',
			schema: verificationRunInput,
			metadata: VERIFICATION_TOOL
		}),
		defineStardustTool({
			name: 'browser.inspect',
			description:
				'Inspect a page with Playwright and capture console, request, accessibility, and screenshot evidence.',
			schema: browserInspectInput,
			metadata: BROWSER_INSPECT_TOOL
		}),
		defineStardustTool({
			name: 'browser.act',
			description:
				'Perform approved browser interactions with Playwright, then capture inspection evidence.',
			schema: browserActionInput,
			metadata: BROWSER_ACTION_TOOL
		}),
		defineStardustTool({
			name: 'repository.inspect',
			description:
				'Read a compact project map: package scripts, dependencies, routes, nearby tests, and git status.',
			schema: repositoryInspectInput,
			metadata: REPOSITORY_INSPECT_TOOL
		}),
		defineStardustTool({
			name: 'temporal.inspect',
			description:
				'Run a read-only Temporal MCP triage for connection, workflow, history, and task queue state.',
			schema: temporalInspectInput,
			metadata: TEMPORAL_MCP_TOOL
		}),
		defineStardustTool({
			name: 'temporal.mcp.call',
			description: 'Call an allowed read-only temporal-mcp tool through Stardust policy.',
			schema: temporalMcpCallInput,
			metadata: TEMPORAL_MCP_TOOL
		}),
		defineStardustTool({
			name: 'artifact.createReport',
			description:
				'Create a local Markdown report artifact from summaries, tool evidence, verification output, and links.',
			schema: reportArtifactInput,
			metadata: SAFE_ARTIFACT_TOOL
		}),
		defineStardustTool({
			name: 'memory.writeCandidate',
			description: 'Propose a memory candidate for user review.',
			schema: memoryWriteCandidateInput,
			metadata: MEMORY_WRITE_CANDIDATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.research',
			description: 'Ask a research delegate to investigate a bounded question.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.code',
			description: 'Ask a code delegate to inspect or implement a bounded coding task.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.critic',
			description: 'Ask a critic delegate for an advisory review.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.parallel',
			description: 'Launch multiple approved child workflow delegate tasks in parallel.',
			schema: delegateParallelInput,
			metadata: DELEGATE_TOOL
		})
	];
}

/**
 * Full set of registered Stardust tools: the core workspace/shell tools, the
 * extended tools (memory, process, sandbox, browser, Temporal, delegate,
 * artifact), and every keyless tool module (timers, session messaging,
 * schedules, public data, local notifications, Playwright MCP, Context7, and
 * the scratch database).
 */
export const registeredTools: RegisteredTool[] = [
	...defineCoreTools(),
	...defineExtendedTools(),
	...defineTimerTools(),
	...defineSessionMessagingTools(),
	...defineScheduleTools(),
	...definePublicDataTools(),
	...defineLocalNotificationTools(),
	...definePlaywrightMcpTools(),
	...defineContext7Tools(),
	...defineScratchDbTools()
];
