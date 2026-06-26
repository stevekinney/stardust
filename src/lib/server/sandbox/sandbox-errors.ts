export class SandboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SandboxError';
	}
}

export class SandboxPathError extends SandboxError {
	constructor(path: string) {
		super(`Sandbox path escapes the workspace: ${path}`);
		this.name = 'SandboxPathError';
	}
}

export class SandboxSessionKeyError extends SandboxError {
	constructor(sessionKey: string) {
		super(`Invalid sandbox session key: ${sessionKey}`);
		this.name = 'SandboxSessionKeyError';
	}
}

export class SandboxUnsupportedProviderError extends SandboxError {
	constructor(provider: string) {
		super(`Unsupported sandbox provider: ${provider}`);
		this.name = 'SandboxUnsupportedProviderError';
	}
}
