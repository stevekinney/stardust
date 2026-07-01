import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { toolInvocations } from '../db/schema';
import { fetchWithSsrfGuard } from '../policy/ssrf';
import { persistToolArtifact } from './artifact-output';
import { actInBrowser, inspectBrowser } from './browser-agent';
import { inspectRepository } from './repository-inspection';
import { callTemporalMcpTool, inspectTemporal } from './temporal-mcp';
import { executeNewToolCall } from './execute-new-tool-call';
import {
	createReportMarkdown,
	diffCommandArguments,
	requireCommandRunner,
	requireSandbox,
	requireSessionRun,
	toMemoryLayer,
	verificationCommand,
	type ExecuteToolCallInput
} from './tool-execution-context';
import {
	applyPatchInput,
	browserActionInput,
	browserInspectInput,
	delegateParallelInput,
	memorySearchInput,
	memoryWriteCandidateInput,
	pathInput,
	processKillInput,
	processStartInput,
	repositoryInspectInput,
	reportArtifactInput,
	sandboxRestoreInput,
	sandboxSnapshotInput,
	searchFilesInput,
	shellExecInput,
	temporalInspectInput,
	temporalMcpCallInput,
	verificationRunInput,
	webFetchInput,
	workspaceDiffInput,
	writeFileInput
} from './tool-definitions';

export type { ExecuteToolCallInput } from './tool-execution-context';

/** Tool names handled by the "new tool module" dispatcher in `execute-new-tool-call.ts`. */
const NEW_TOOL_NAMES = new Set([
	'timer.wait',
	'session.sendMessage',
	'schedule.create',
	'schedule.list',
	'notify.user',
	'imessage.send',
	'browser.mcp.call',
	'docs.lookup',
	'db.query',
	'feed.read',
	'hackernews.read',
	'weather.lookup',
	'wikipedia.lookup'
]);

/**
 * Executes a single allowed tool call and returns its raw (unfenced,
 * untruncated) result content. Called only after `executeRegisteredTool` has
 * confirmed the call is allowed (or approved) — this function does no policy
 * checks of its own.
 *
 * Dispatches calls for the keyless "new tool" modules (timers, session
 * messaging, schedules, public data, local notifications, Playwright MCP,
 * Context7, and the scratch database) to {@link executeNewToolCall}; every
 * other tool is handled directly below.
 */
export async function executeToolCall(input: ExecuteToolCallInput): Promise<unknown> {
	if (NEW_TOOL_NAMES.has(input.call.name)) {
		return executeNewToolCall(input);
	}

	switch (input.call.name) {
		case 'web.fetch':
			return fetchWithSsrfGuard(webFetchInput.parse(input.call.arguments), input.fetcher);
		case 'workspace.readFile': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const args = pathInput.parse(input.call.arguments);
			return sandbox.readFile({ sessionKey, path: args.path });
		}
		case 'workspace.writeFile': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const args = writeFileInput.parse(input.call.arguments);
			// Snapshot the workspace before mutation so it can be restored if needed.
			await sandbox.snapshot({
				sessionKey,
				runId: input.runId,
				toolCallId: input.call.id,
				reason: `pre-write: ${args.path}`
			});
			await sandbox.writeFile({ sessionKey, path: args.path, contents: args.content });
			const written = await sandbox.readFile({ sessionKey, path: args.path });
			return { path: args.path, bytes: Buffer.byteLength(written) };
		}
		case 'workspace.applyPatch': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const runCommand = requireCommandRunner(input.runSandboxCommand);
			const args = applyPatchInput.parse(input.call.arguments);
			// Write the patch content to a temp file inside the workspace.  The
			// provider's runCommand has no stdin support, so we use `patch -i
			// <tempfile>` rather than piping to stdin.
			const tempPatchPath = `.stardust-patch-${randomUUID()}.patch`;
			await sandbox.writeFile({ sessionKey, path: tempPatchPath, contents: args.patch });
			// Snapshot before the patch is applied.
			await sandbox.snapshot({
				sessionKey,
				runId: input.runId,
				toolCallId: input.call.id,
				reason: `pre-apply-patch: ${args.path}`
			});
			try {
				const patchResult = await runCommand({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: 'patch',
					args: ['--no-backup-if-mismatch', '--reject-file=-', '-i', tempPatchPath, args.path],
					toolCallId: input.call.id
				});
				if (patchResult.exitCode !== 0) {
					throw new Error(
						`patch failed (exit ${patchResult.exitCode}): ${patchResult.stderr || patchResult.stdout}`.trimEnd()
					);
				}
			} finally {
				// Best-effort cleanup of the temporary patch file.
				try {
					await runCommand({
						sessionKey,
						runId: input.runId ?? 'tool',
						command: 'rm',
						args: ['-f', tempPatchPath],
						toolCallId: `${input.call.id}-cleanup`
					});
				} catch {
					// Cleanup failures are non-fatal; the sandbox snapshot absorbs the temp file.
				}
			}
			const patched = await sandbox.readFile({ sessionKey, path: args.path });
			return { path: args.path, bytes: Buffer.byteLength(patched) };
		}
		case 'shell.exec': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const runCommand = requireCommandRunner(input.runSandboxCommand);
			const args = shellExecInput.parse(input.call.arguments);
			// Snapshot before arbitrary shell execution so the workspace state is
			// recoverable regardless of what the command does.
			await sandbox.snapshot({
				sessionKey,
				runId: input.runId,
				toolCallId: input.call.id,
				reason: `pre-shell: ${args.command}`
			});
			const result = await runCommand({
				sessionKey,
				runId: input.runId ?? 'tool',
				command: args.command,
				args: args.args,
				timeoutMs: args.timeoutMs,
				toolCallId: input.call.id
			});
			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				timedOut: result.timedOut,
				status: result.status
			};
		}
		case 'process.start': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const startProcess = input.startSandboxProcess ?? sandbox.startProcess.bind(sandbox);
			const args = processStartInput.parse(input.call.arguments);
			return startProcess({
				sessionKey,
				runId: input.runId ?? 'tool',
				command: args.command,
				args: args.args,
				cwd: args.workingDirectory,
				timeoutMs: args.timeoutMs,
				toolCallId: input.call.id
			});
		}
		case 'process.kill': {
			const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const killProcess =
				input.killSandboxProcess ?? input.sandboxProvider!.killProcess.bind(input.sandboxProvider);
			const args = processKillInput.parse(input.call.arguments);
			return killProcess({
				sessionKey,
				processId: args.processId,
				signal: args.signal
			});
		}
		case 'workspace.searchFiles': {
			const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const runCommand = requireCommandRunner(input.runSandboxCommand);
			const args = searchFilesInput.parse(input.call.arguments);
			const findResult = await runCommand({
				sessionKey,
				runId: input.runId ?? 'tool',
				command: 'find',
				args: [args.path ?? '.', '-name', args.pattern, '-type', 'f'],
				toolCallId: input.call.id
			});
			return {
				files: findResult.stdout.split('\n').filter(Boolean),
				pattern: args.pattern
			};
		}
		case 'workspace.diff': {
			const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const runCommand = requireCommandRunner(input.runSandboxCommand);
			const args = workspaceDiffInput.parse(input.call.arguments);
			const result = await runCommand({
				sessionKey,
				runId: input.runId ?? 'tool',
				command: 'git',
				args: diffCommandArguments(args),
				toolCallId: input.call.id
			});
			const artifact =
				input.artifactStore && input.sessionId && input.sessionKey && input.runId && result.stdout
					? await persistToolArtifact({
							sessionId: input.sessionId,
							sessionKey: input.sessionKey,
							runId: input.runId,
							toolCallId: input.call.id,
							artifactStore: input.artifactStore,
							database: input.database,
							content: result.stdout,
							mimeType: 'text/x-patch',
							extension: 'patch'
						})
					: null;
			return {
				base: args.base ?? 'working-tree',
				head: args.head ?? null,
				path: args.path ?? null,
				exitCode: result.exitCode,
				status: result.status,
				patch: result.stdout,
				stderr: result.stderr,
				artifact
			};
		}
		case 'sandbox.snapshot': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const args = sandboxSnapshotInput.parse(input.call.arguments);
			const snapshot = await sandbox.snapshot({
				sessionKey,
				runId: input.runId,
				toolCallId: input.call.id,
				reason: args.description ? `${args.label}: ${args.description}` : args.label
			});
			return {
				id: snapshot.id,
				label: args.label,
				gitCommitSha: snapshot.gitCommitSha,
				createdAt: snapshot.createdAt
			};
		}
		case 'sandbox.restore': {
			const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const args = sandboxRestoreInput.parse(input.call.arguments);
			await sandbox.restore(sessionKey, args.snapshotId);
			return {
				snapshotId: args.snapshotId,
				restoredAt: new Date().toISOString(),
				reason: args.reason ?? null
			};
		}
		case 'verification.run': {
			const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
			const runCommand = requireCommandRunner(input.runSandboxCommand);
			const args = verificationRunInput.parse(input.call.arguments);
			const command = verificationCommand(args);
			const result = await runCommand({
				sessionKey,
				runId: input.runId ?? 'tool',
				command: command.command,
				args: command.args,
				timeoutMs: args.timeoutMs,
				toolCallId: input.call.id
			});
			const log = [
				`$ ${[command.command, ...command.args].join(' ')}`,
				'',
				'## stdout',
				result.stdout || '(empty)',
				'',
				'## stderr',
				result.stderr || '(empty)'
			].join('\n');
			const artifact =
				input.artifactStore && input.sessionId && input.sessionKey && input.runId
					? await persistToolArtifact({
							sessionId: input.sessionId,
							sessionKey: input.sessionKey,
							runId: input.runId,
							toolCallId: input.call.id,
							artifactStore: input.artifactStore,
							database: input.database,
							content: log,
							mimeType: 'text/markdown',
							extension: 'md'
						})
					: null;
			return {
				check: args.check,
				command: command.command,
				args: command.args,
				status: result.status,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				stdout: result.stdout,
				stderr: result.stderr,
				artifact
			};
		}
		case 'browser.inspect': {
			const { sessionKey, runId } = requireSessionRun(input);
			if (!input.sessionId)
				throw new Error('sessionId is required for browser.inspect but was not provided');
			const args = browserInspectInput.parse(input.call.arguments);
			return inspectBrowser({
				...args,
				sessionId: input.sessionId,
				sessionKey,
				runId,
				toolCallId: input.call.id,
				artifactStore: input.artifactStore,
				database: input.database
			});
		}
		case 'browser.act': {
			const { sessionKey, runId } = requireSessionRun(input);
			if (!input.sessionId)
				throw new Error('sessionId is required for browser.act but was not provided');
			const args = browserActionInput.parse(input.call.arguments);
			return actInBrowser({
				...args,
				sessionId: input.sessionId,
				sessionKey,
				runId,
				toolCallId: input.call.id,
				artifactStore: input.artifactStore,
				database: input.database
			});
		}
		case 'repository.inspect': {
			const { sessionKey, runId } = requireSessionRun(input);
			const args = repositoryInspectInput.parse(input.call.arguments);
			return inspectRepository({
				sessionKey,
				runId,
				workspacePath: input.workspacePath,
				runCommand: input.runSandboxCommand,
				...args
			});
		}
		case 'temporal.inspect': {
			const content = await inspectTemporal(temporalInspectInput.parse(input.call.arguments));
			if (input.artifactStore && input.sessionId && input.sessionKey && input.runId) {
				return {
					...(content as Record<string, unknown>),
					artifact: await persistToolArtifact({
						sessionId: input.sessionId,
						sessionKey: input.sessionKey,
						runId: input.runId,
						toolCallId: input.call.id,
						artifactStore: input.artifactStore,
						database: input.database,
						content: JSON.stringify(content, null, 2),
						mimeType: 'application/json',
						extension: 'json'
					})
				};
			}
			return content;
		}
		case 'temporal.mcp.call': {
			const args = temporalMcpCallInput.parse(input.call.arguments);
			return callTemporalMcpTool({ toolName: args.toolName, arguments: args.arguments });
		}
		case 'artifact.createReport': {
			const { sessionKey, runId } = requireSessionRun(input);
			if (!input.sessionId || !input.artifactStore) {
				throw new Error(
					'sessionId and artifactStore are required for artifact.createReport but were not provided'
				);
			}
			const args = reportArtifactInput.parse(input.call.arguments);
			const toolRows =
				input.database && args.includeToolResults
					? await input.database
							.select()
							.from(toolInvocations)
							.where(eq(toolInvocations.runId, runId))
					: [];
			return persistToolArtifact({
				sessionId: input.sessionId,
				sessionKey,
				runId,
				toolCallId: input.call.id,
				artifactStore: input.artifactStore,
				database: input.database,
				content: createReportMarkdown({
					title: args.title,
					summary: args.summary,
					sections: args.sections,
					includeToolResults: args.includeToolResults,
					toolRows
				}),
				mimeType: 'text/markdown',
				extension: 'md'
			});
		}
		case 'delegate.parallel': {
			const args = delegateParallelInput.parse(input.call.arguments);
			return {
				tasks: args.tasks,
				message:
					'delegate.parallel is executed by the orchestrator workflow after approval, not inside the tool activity.'
			};
		}
		case 'memory.search': {
			if (!input.searchMemory) {
				throw new Error('searchMemory is required for memory.search but was not provided');
			}
			const { sessionKey } = requireSessionRun(input);
			const args = memorySearchInput.parse(input.call.arguments);
			return input.searchMemory({
				sessionId: sessionKey,
				query: args.query,
				layers: args.layers?.map(toMemoryLayer),
				limit: args.limit
			});
		}
		case 'memory.writeCandidate': {
			if (!input.writeMemoryCandidate) {
				throw new Error(
					'writeMemoryCandidate is required for memory.writeCandidate but was not provided'
				);
			}
			const { sessionKey, runId } = requireSessionRun(input);
			const args = memoryWriteCandidateInput.parse(input.call.arguments);
			return input.writeMemoryCandidate({
				sessionId: sessionKey,
				runId,
				layer: toMemoryLayer(args.layer),
				content: args.content,
				reason: args.rationale ?? null
			});
		}
		default:
			throw new Error(`Unknown tool: ${input.call.name}`);
	}
}
