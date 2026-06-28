import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization with sorted object keys so that two objects
 * with the same key-value pairs but different insertion order produce the same
 * string. Used to generate a stable, content-addressable hash of tool arguments.
 */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b)
		);
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

/**
 * Returns a SHA-256 hex digest of the stable-serialized tool arguments.
 * Used to populate `args_hash` in both `tool_invocations` and `approval_requests`
 * so the hash is byte-for-byte identical across tables for the same arguments.
 */
export function hashApprovalArguments(argumentsValue: unknown): string {
	return createHash('sha256').update(stableStringify(argumentsValue)).digest('hex');
}
