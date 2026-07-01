import { defineTool, serializeToolDefinition, type AnyToolDefinition } from 'armorer/core';
import type { z } from 'zod';
import type { ToolMetadata } from '@src/lib/types';
import type { RegisteredTool } from '../policy/policy-engine';

/** Build a `RegisteredTool` record backed by an armorer definition. */
export function defineStardustTool(input: {
	name: string;
	description: string;
	schema: z.ZodTypeAny;
	metadata: ToolMetadata;
}): RegisteredTool {
	const definition = defineTool({
		name: input.name,
		description: input.description,
		input: input.schema,
		metadata: input.metadata
	});
	const serialized = serializeToolDefinition(definition as AnyToolDefinition);
	return {
		name: serialized.identity.name,
		description: serialized.display.description,
		inputSchema: serialized.input,
		metadata: input.metadata,
		schema: input.schema
	};
}
