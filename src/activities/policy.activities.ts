import type { ToolCallInput, ToolManifestEntry, ToolPolicyDecision } from '@src/lib/types';
import { registeredTools, getToolManifest } from '../lib/server/tools/registry';
import { validateToolCall } from '../lib/server/policy/policy-engine';

export async function listToolManifest(input?: {
	allowedToolNames?: string[];
}): Promise<ToolManifestEntry[]> {
	return getToolManifest(input);
}

export async function evaluateToolCallPolicy(input: {
	call: ToolCallInput;
}): Promise<ToolPolicyDecision> {
	return validateToolCall(registeredTools, input.call);
}
