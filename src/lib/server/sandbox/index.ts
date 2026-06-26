import type { DatabaseClient } from '../db';
import { SandboxUnsupportedProviderError } from './sandbox-errors';
import { LocalSubprocessSandboxProvider } from './local-subprocess-provider';
import type { SandboxProvider, SandboxProviderName } from './sandbox-provider';

export { LocalSubprocessSandboxProvider } from './local-subprocess-provider';
export type * from './sandbox-provider';
export * from './sandbox-errors';
export * from './sandbox-names';
export * from './sandbox-budget';

interface SandboxProviderFactoryOptions {
	workspaceRoot?: string;
	database?: DatabaseClient;
}

export function getSandboxProvider(options: SandboxProviderFactoryOptions = {}): SandboxProvider {
	const provider = (process.env.SANDBOX_PROVIDER ?? 'local-subprocess') as SandboxProviderName;

	if (provider === 'local-subprocess') {
		return new LocalSubprocessSandboxProvider(options);
	}

	throw new SandboxUnsupportedProviderError(provider);
}
