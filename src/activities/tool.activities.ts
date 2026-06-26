import type { ToolExecutionInput, ToolExecutionResult } from '@src/lib/types';
import { db } from '../lib/server/db/client';
import { executeRegisteredTool } from '../lib/server/tools/registry';

export async function executeTool(
	input: ToolExecutionInput & { approved?: boolean }
): Promise<ToolExecutionResult> {
	return executeRegisteredTool({ ...input, database: db });
}
