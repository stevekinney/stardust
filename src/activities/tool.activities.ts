import type { ToolExecutionInput, ToolExecutionResult } from '@src/lib/types';
import { db } from '../lib/server/db/client';
import { getArtifactStore } from '../lib/server/artifacts';
import { getSandboxProvider } from '../lib/server/sandbox';
import { executeRegisteredTool } from '../lib/server/tools/registry';

const artifactStore = getArtifactStore();
const sandboxProvider = getSandboxProvider({ database: db });

export async function executeTool(
	input: ToolExecutionInput & { approved?: boolean }
): Promise<ToolExecutionResult> {
	return executeRegisteredTool({ ...input, database: db, artifactStore, sandboxProvider });
}
