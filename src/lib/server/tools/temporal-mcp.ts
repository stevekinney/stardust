import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../config';

const DENIED_TOOLS = new Set(['docs.refresh']);
const require = createRequire(import.meta.url);
const ALLOWED_PREFIXES = [
	'temporal.workflow.',
	'temporal.schedule.',
	'temporal.task-queue.',
	'temporal.namespace.',
	'temporal.search-attributes.',
	'temporal.cluster.',
	'temporal.worker.',
	'temporal.connection.',
	'docs.'
];

type TemporalMcpClientLike = {
	listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }>;
	callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
};

let cachedClient: TemporalMcpClientLike | null = null;

export async function callTemporalMcpTool(input: {
	toolName: string;
	arguments?: Record<string, unknown>;
	client?: TemporalMcpClientLike;
}) {
	if (!isTemporalMcpToolAllowed(input.toolName)) {
		throw new Error(`Temporal MCP tool is not allowed: ${input.toolName}`);
	}
	const client = input.client ?? (await getTemporalMcpClient());
	return normalizeMcpResult(
		await client.callTool({ name: input.toolName, arguments: input.arguments ?? {} })
	);
}

export async function inspectTemporal(input: {
	workflowId?: string;
	runId?: string;
	taskQueue?: string;
	namespace?: string;
	client?: TemporalMcpClientLike;
}) {
	const namespace = input.namespace ?? TEMPORAL_NAMESPACE;
	const calls: Array<{ label: string; toolName: string; arguments: Record<string, unknown> }> = [
		{ label: 'connection', toolName: 'temporal.connection.check', arguments: { namespace } },
		{ label: 'cluster', toolName: 'temporal.cluster.info', arguments: { namespace } }
	];

	if (input.workflowId) {
		calls.push(
			{
				label: 'workflow',
				toolName: 'temporal.workflow.describe',
				arguments: {
					namespace,
					workflowId: input.workflowId,
					...(input.runId ? { runId: input.runId } : {})
				}
			},
			{
				label: 'history',
				toolName: 'temporal.workflow.history.summarize',
				arguments: {
					namespace,
					workflowId: input.workflowId,
					...(input.runId ? { runId: input.runId } : {})
				}
			}
		);
	}

	if (input.taskQueue) {
		calls.push({
			label: 'taskQueue',
			toolName: 'temporal.task-queue.describe',
			arguments: { namespace, taskQueue: input.taskQueue }
		});
	}

	const results = [];
	for (const call of calls) {
		try {
			results.push({
				label: call.label,
				toolName: call.toolName,
				status: 'success',
				result: await callTemporalMcpTool({
					toolName: call.toolName,
					arguments: call.arguments,
					client: input.client
				})
			});
		} catch (error) {
			results.push({
				label: call.label,
				toolName: call.toolName,
				status: 'error',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	return {
		namespace,
		address: TEMPORAL_ADDRESS,
		workflowId: input.workflowId ?? null,
		runId: input.runId ?? null,
		taskQueue: input.taskQueue ?? null,
		results
	};
}

export function isTemporalMcpToolAllowed(toolName: string): boolean {
	return (
		!DENIED_TOOLS.has(toolName) && ALLOWED_PREFIXES.some((prefix) => toolName.startsWith(prefix))
	);
}

async function getTemporalMcpClient(): Promise<TemporalMcpClientLike> {
	if (cachedClient) return cachedClient;
	const configPath = await writeTemporalMcpConfiguration();
	const client = new Client({ name: 'stardust-temporal-mcp-client', version: '0.0.1' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [require.resolve('temporal-mcp')],
			env: {
				...process.env,
				TEMPORAL_MCP_CONFIG: configPath
			},
			stderr: 'pipe'
		})
	);
	cachedClient = client;
	return client;
}

async function writeTemporalMcpConfiguration(): Promise<string> {
	const directory = join(tmpdir(), 'stardust-temporal-mcp');
	await mkdir(directory, { recursive: true });
	const configPath = join(directory, `config-${process.pid}.json`);
	await writeFile(
		configPath,
		JSON.stringify(
			{
				temporal: {
					defaultProfile: 'stardust-local',
					profiles: {
						'stardust-local': {
							kind: 'self-hosted',
							address: TEMPORAL_ADDRESS,
							namespace: TEMPORAL_NAMESPACE
						}
					}
				},
				policy: {
					mode: 'readOnly',
					hardReadOnly: true,
					allowedProfiles: ['stardust-local'],
					allowedNamespaces: [TEMPORAL_NAMESPACE]
				}
			},
			null,
			2
		),
		'utf8'
	);
	return configPath;
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
