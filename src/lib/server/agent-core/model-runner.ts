import Anthropic from '@anthropic-ai/sdk';
import { toAnthropicTools } from 'armorer/adapters/anthropic';
import type { AnthropicTool } from 'armorer/adapters/anthropic';
import type { JsonObject, SerializedToolDefinition } from 'armorer/core';
import { ApplicationFailure } from '@temporalio/common';
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
import { serverToolsForModel } from './server-tools';

type ProviderRequest = {
	model: string;
	maxTokens: number;
	system?: string;
	messages: unknown[];
	tools?: AnthropicTool[];
};

type ProviderResult = {
	message: AnthropicMessageResponse;
};

/** Called by the provider for each text token as it arrives from the model stream. */
type OnDelta = (delta: string) => Promise<void>;

export type ModelProviderClient = {
	/**
	 * Sends a message request to the model provider. As text tokens arrive from
	 * the provider stream, `onDelta` is called with each token so callers can
	 * persist or forward them before the final result is available.
	 */
	createMessage(input: ProviderRequest, onDelta: OnDelta): Promise<ProviderResult>;
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

/** Fetches one streamed model response, forwarding text deltas via `onDelta`. */
type StreamOnce = (messages: unknown[], onDelta: OnDelta) => Promise<AnthropicMessageResponse>;

/** Maximum number of `pause_turn` continuations before giving up and returning
 *  whatever has accumulated so far. */
const MAX_PAUSE_TURN_CONTINUATIONS = 5;

/**
 * Runs a model stream request and automatically continues it when the
 * response is interrupted mid-way by Anthropic's server-tool loop
 * (`stop_reason: 'pause_turn'`). Per Anthropic's continuation contract, each
 * continuation appends the assistant's partial response as an assistant turn
 * and re-issues the request with the same messages otherwise unchanged — no
 * user message is added between iterations, since the API resumes from the
 * trailing `server_tool_use` block. Stops after `maxContinuations` re-issues
 * and returns whatever has accumulated so far. `content` and token `usage`
 * are merged across every iteration, in order.
 */
export async function continueAnthropicStream(
	initialMessages: unknown[],
	streamOnce: StreamOnce,
	onDelta: OnDelta,
	maxContinuations: number = MAX_PAUSE_TURN_CONTINUATIONS
): Promise<AnthropicMessageResponse> {
	let messages = initialMessages;
	let mergedContent: AnthropicMessageResponse['content'] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let continuations = 0;
	let latest: AnthropicMessageResponse;

	for (;;) {
		latest = await streamOnce(messages, onDelta);
		mergedContent = mergedContent.concat(latest.content);
		inputTokens += latest.usage?.input_tokens ?? 0;
		outputTokens += latest.usage?.output_tokens ?? 0;

		if (latest.stop_reason !== 'pause_turn' || continuations >= maxContinuations) {
			break;
		}
		continuations++;
		messages = [...messages, { role: 'assistant' as const, content: latest.content }];
	}

	return {
		...latest,
		content: mergedContent,
		usage: { input_tokens: inputTokens, output_tokens: outputTokens }
	};
}

function createAnthropicProvider(apiKey: string): ModelProviderClient {
	const client = new Anthropic({ apiKey });

	return {
		async createMessage(input, onDelta) {
			const { tools: serverTools, betaHeaders } = serverToolsForModel(input.model);
			const tools = [...(input.tools ?? []), ...serverTools];
			const requestOptions = betaHeaders.length
				? { headers: { 'anthropic-beta': betaHeaders.join(',') } }
				: undefined;

			const streamOnce: StreamOnce = async (messages, forwardDelta) => {
				const stream = client.messages.stream(
					{
						model: input.model,
						max_tokens: input.maxTokens,
						...(input.system ? { system: input.system } : {}),
						messages: messages as never,
						tools: tools as never
					},
					requestOptions
				);

				// Publish each text token to the stream bus as it arrives, before the
				// final structured result is available to the workflow.
				for await (const event of stream) {
					if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
						await forwardDelta(event.delta.text);
					}
				}

				return (await stream.finalMessage()) as AnthropicMessageResponse;
			};

			const message = await continueAnthropicStream(input.messages, streamOnce, onDelta);
			return { message };
		}
	};
}

function readApiKey(input?: string): string {
	const apiKey = input ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw ApplicationFailure.nonRetryable('ANTHROPIC_API_KEY is required to call the model');
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
		systemPrompt: input.systemPrompt,
		steeringMessages: input.steeringMessages,
		memoryNotes: input.memoryNotes,
		workspacePath: input.workspacePath
	});
	const tools = formatToolsForAnthropic(input.tools);

	// Publish each incoming text token to the live stream bus before the final
	// model result is available, so the UI can render assistant text incrementally.
	let deltaIndex = 0;
	const onDelta: OnDelta = async (delta) => {
		const currentDeltaIndex = deltaIndex++;
		await publishAssistantDeltas(database, {
			sessionId: input.sessionId,
			runId: input.runId,
			deduplicationKey: `assistant-delta:${input.modelCallId}:${currentDeltaIndex}`,
			chunks: [delta]
		});
	};

	const result = await provider.createMessage(
		{
			model: input.model,
			maxTokens: input.maxTokens ?? 1024,
			...(context.anthropic.system ? { system: context.anthropic.system } : {}),
			messages: context.anthropic.messages,
			...(tools.length ? { tools } : {})
		},
		onDelta
	);
	const usageTokens = readAnthropicUsage(result.message);
	const message: NormalizedModelMessage = normalizeAnthropicMessage(result.message);
	const now = new Date().toISOString();

	if (message.toolCalls.length > 0) {
		// Intermediate turn: the model is requesting tool execution.
		// Write a tool_call transcript event so the next model call sees the tool
		// requests in its context window and so the context builder can reconstruct
		// the multi-turn conversation correctly.
		await appendTranscriptEvent(database, {
			id: `${input.modelCallId}:tool-call`,
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
				deduplicationKey: `tool-call:${input.modelCallId}:${tc.id}`,
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
