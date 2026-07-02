/**
 * Translates internal tool names across the Anthropic API boundary.
 *
 * Internal tool names are dot-namespaced (`workspace.write`, `memory.search`),
 * but the Anthropic API requires tool names to match `^[a-zA-Z0-9_-]{1,128}$`
 * — both in the `tools` array and in replayed `tool_use` blocks. Everything
 * else in the system (registry, policy, transcripts, UI) keeps the canonical
 * dotted names; only what the model sees is sanitized, and `tool_use`
 * responses are mapped back to canonical names before they touch the
 * transcript or the tool executor.
 */

const INVALID_MODEL_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * The API-safe name the model sees for an internal tool name. Dots become a
 * double underscore so namespaced tools stay disjoint from Anthropic's hosted
 * server tools (`web.fetch` → `web__fetch`, never the hosted `web_fetch`).
 */
export function toModelToolName(name: string): string {
	return name.replace(/\./g, '__').replace(INVALID_MODEL_TOOL_NAME_CHARS, '_').slice(0, 128);
}

/**
 * Builds the reverse index (model-safe name → canonical name) for one model
 * call's tool set. Throws when two canonical names sanitize to the same
 * model-safe name — a silent collision would route the model's tool_use to
 * the wrong executor.
 */
export function buildCanonicalToolNameIndex(names: Iterable<string>): Map<string, string> {
	const index = new Map<string, string>();
	for (const name of names) {
		const modelName = toModelToolName(name);
		const existing = index.get(modelName);
		if (existing !== undefined && existing !== name) {
			throw new Error(
				`Tool names "${existing}" and "${name}" both sanitize to "${modelName}" for the model API; rename one of them`
			);
		}
		index.set(modelName, name);
	}
	return index;
}

/** Canonical name for a model-reported tool name; unknown names pass through unchanged. */
export function fromModelToolName(name: string, index: Map<string, string>): string {
	return index.get(name) ?? name;
}
