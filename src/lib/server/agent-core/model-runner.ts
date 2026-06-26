import Anthropic from '@anthropic-ai/sdk';
import { toAnthropicTools } from 'armorer/adapters/anthropic';
import type { AnthropicTool } from 'armorer/adapters/anthropic';
import type { JsonObject, SerializedToolDefinition } from 'armorer/core';
import { ApplicationFailure } from '@temporalio/common';
import { randomUUID } from 'node:crypto';
import type {
	ModelCallInput,
	ModelCallResult,
	ModelToolSchema,
	NormalizedModelMessage
} from '@src/lib/types';
import { db } from '../db/client';
import type { DatabaseClient } from '../db/client';
import { appendTranscriptEvent, publishAssistantDeltas, publishStreamEvent } from '../stream';
import { assertKnownModel, calculateModelUsage } from './budgets';
import { buildModelContext } from './context-builder';
import {
	normalizeAnthropicMessage,
	readAnthropicUsage,
	type AnthropicMessageResponse
} from './model-response-normalizer';

type ProviderRequest = {
	model: string;
	maxTokens: number;
	system?: string;
	messages: unknown[];
	tools?: AnthropicTool[];
};

type ProviderResult = {
	message: AnthropicMessageResponse;
	deltas?: string[];
};

export type ModelProviderClient = {
	createMessage(input: ProviderRequest): Promise<ProviderResult>;
};

export type RunModelCallDependencies = {
	database?: DatabaseClient;
	provider?: ModelProviderClient;
	apiKey?: string;
};

export function classifyModelProviderError(error: unknown): 'transient' | 'permanent' {
	const status =
		typeof error === 'object' && error ? (error as { status?: unknown }).status : undefined;
	if (typeof status === 'number' && (status === 429 || status >= 500)) return 'transient';
	return 'permanent';
}

export function formatToolsForAnthropic(tools: ModelToolSchema[] = []): AnthropicTool[] {
	const serializedTools: SerializedToolDefinition[] = tools.map((tool) => ({
		schemaVersion: '2020-12',
		id: `${tool.identity.namespace ?? 'default'}:${tool.identity.name}`,
		identity: {
			namespace: tool.identity.namespace ?? 'default',
			name: tool.identity.name,
			...(tool.identity.version ? { version: tool.identity.version } : {})
		},
		display: tool.display,
		name: tool.identity.name,
		description: tool.display.description,
		aliases: [],
		input: tool.input as JsonObject
	}));

	return toAnthropicTools(serializedTools);
}

function createAnthropicProvider(apiKey: string): ModelProviderClient {
	const client = new Anthropic({ apiKey });

	return {
		async createMessage(input) {
			const message = (await client.messages.create({
				model: input.model,
				max_tokens: input.maxTokens,
				...(input.system ? { system: input.system } : {}),
				messages: input.messages as never,
				...(input.tools?.length ? { tools: input.tools as never } : {})
			})) as AnthropicMessageResponse;
			const normalized = normalizeAnthropicMessage(message);
			return {
				message,
				deltas: normalized.text ? [normalized.text] : []
			};
		}
	};
}

function readApiKey(input?: string): string {
	const apiKey = input ?? process.env.MODEL_API_KEY;
	if (!apiKey) {
		throw ApplicationFailure.nonRetryable('MODEL_API_KEY is required to call the model');
	}
	return apiKey;
}

export async function runModelCall(
	input: ModelCallInput,
	dependencies: RunModelCallDependencies = {}
): Promise<ModelCallResult> {
	try {
		assertKnownModel(input.model);
	} catch (error) {
		throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error));
	}

	const database = dependencies.database ?? db;
	const apiKey = readApiKey(dependencies.apiKey);
	const provider = dependencies.provider ?? createAnthropicProvider(apiKey);
	const context = await buildModelContext(database, {
		sessionId: input.sessionId,
		systemPrompt: input.systemPrompt
	});
	const tools = formatToolsForAnthropic(input.tools);
	const result = await provider.createMessage({
		model: input.model,
		maxTokens: input.maxTokens ?? 1024,
		...(context.anthropic.system ? { system: context.anthropic.system } : {}),
		messages: context.anthropic.messages,
		...(tools.length ? { tools } : {})
	});
	const usageTokens = readAnthropicUsage(result.message);
	const message: NormalizedModelMessage = normalizeAnthropicMessage(result.message);
	const deltas = result.deltas ?? (message.text ? [message.text] : []);
	const now = new Date().toISOString();

	// Publish assistant deltas to the live stream bus for SSE rendering.
	await publishAssistantDeltas(database, {
		sessionId: input.sessionId,
		runId: input.runId,
		chunks: deltas
	});

	if (message.toolCalls.length > 0) {
		// Intermediate turn: the model is requesting tool execution.
		// Write a tool_call transcript event so the next model call sees the tool
		// requests in its context window and so the context builder can reconstruct
		// the multi-turn conversation correctly.
		const turnId = randomUUID();
		await appendTranscriptEvent(database, {
			id: `${input.runId}:tool-call:${turnId}`,
			sessionId: input.sessionId,
			runId: input.runId,
			kind: 'tool_call',
			payload: JSON.stringify({
				text: message.text || undefined,
				calls: message.toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					input: tc.input
				}))
			}),
			createdAt: now
		});

		// Emit individual tool.call stream events so the UI can render tool cards.
		for (const tc of message.toolCalls) {
			await publishStreamEvent(database, {
				sessionId: input.sessionId,
				runId: input.runId,
				kind: 'tool.call',
				payload: JSON.stringify({ id: tc.id, name: tc.name, input: tc.input }),
				createdAt: now
			});
		}
	}

	return {
		runId: input.runId,
		model: input.model,
		message,
		usage: calculateModelUsage({
			model: input.model,
			inputTokens: usageTokens.inputTokens,
			outputTokens: usageTokens.outputTokens
		})
	};
}
