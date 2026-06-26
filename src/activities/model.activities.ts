import type { ModelCallInput, ModelCallResult } from '@src/lib/types';
import { runModelCall } from '../lib/server/agent-core/model-runner';

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
	return runModelCall(input);
}
