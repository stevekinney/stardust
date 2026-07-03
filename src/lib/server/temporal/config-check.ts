/**
 * Coherence checks for the resolved Temporal configuration.
 *
 * The app is configured entirely through `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`
 * / `TEMPORAL_API_KEY`. Because `.env` loading never overrides a variable that is
 * already present in the process environment, a stray Temporal *Cloud* export in
 * the shell (e.g. `TEMPORAL_NAMESPACE=depict.bnfgy` for a Cloud profile) silently
 * beats the local `default` in `.env` — leaving the stack pointed at a namespace
 * that does not exist on the local dev server. Every workflow call then fails with
 * an opaque error.
 *
 * These helpers turn that silent, class-of-bug footgun into a loud, actionable
 * failure at the boundary where the configuration is first used.
 */

/** Loopback hosts that indicate a *local* Temporal dev server. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Host suffixes that identify a managed Temporal *Cloud* endpoint. */
const CLOUD_HOST_SUFFIXES = ['.temporal.io', '.tmprl.cloud'];

/** The Temporal configuration a process resolved and is about to use. */
export type TemporalConfig = {
	address: string;
	namespace: string;
	apiKey?: string | undefined;
};

/** A detected configuration problem: a one-line `summary` plus multi-line `detail`. */
export type TemporalConfigProblem = {
	/** One-line description, suitable for an error banner. */
	summary: string;
	/** Multi-line remediation, suitable for a terminal or server log. */
	detail: string;
};

/** Extract the host from a `host:port` address, tolerating bracketed IPv6. */
function hostOf(address: string): string {
	const trimmed = address.trim();
	if (trimmed.startsWith('[')) {
		// Bracketed IPv6, e.g. "[::1]:7233" → "[::1]".
		const close = trimmed.indexOf(']');
		return close === -1 ? trimmed.toLowerCase() : trimmed.slice(0, close + 1).toLowerCase();
	}
	const lastColon = trimmed.lastIndexOf(':');
	const host = lastColon === -1 ? trimmed : trimmed.slice(0, lastColon);
	return host.toLowerCase();
}

/** True when the address points at a local Temporal dev server (loopback host). */
export function isLocalTemporalAddress(address: string): boolean {
	return LOCAL_HOSTS.has(hostOf(address));
}

/** True when the address points at a managed Temporal Cloud endpoint. */
export function isCloudTemporalAddress(address: string): boolean {
	const host = hostOf(address);
	return CLOUD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Returns a {@link TemporalConfigProblem} when the resolved configuration is
 * internally incoherent, or `null` when it is coherent.
 *
 * Two cases are detected:
 *  - a *local* address paired with Cloud credentials (a leaked-shell-env override);
 *  - a *Cloud* address with no API key (authentication would fail).
 */
export function describeTemporalConfigProblem(
	config: TemporalConfig
): TemporalConfigProblem | null {
	const hasApiKey = Boolean(config.apiKey && config.apiKey.length > 0);
	// Temporal Cloud namespaces are "<name>.<accountId>"; local ones are bare.
	const cloudLookingNamespace = config.namespace.includes('.');

	if (isLocalTemporalAddress(config.address) && (hasApiKey || cloudLookingNamespace)) {
		const leaked = [
			cloudLookingNamespace ? `TEMPORAL_NAMESPACE=${config.namespace}` : null,
			hasApiKey ? 'TEMPORAL_API_KEY=<set>' : null
		]
			.filter(Boolean)
			.join(', ');
		return {
			summary:
				`Temporal is pointed at the local dev server (${config.address}) but Cloud ` +
				`credentials are set (${leaked}) — they overrode .env, so the app is using a ` +
				`namespace that does not exist locally.`,
			detail:
				'These almost certainly leaked in from your shell (a Temporal Cloud profile) and\n' +
				'silently overrode .env, because env loading never overrides an already-set variable.\n\n' +
				'To use the local dev server, clear them and restart:\n' +
				'  unset TEMPORAL_NAMESPACE TEMPORAL_API_KEY\n\n' +
				'To target Temporal Cloud instead, set TEMPORAL_ADDRESS to your Cloud endpoint\n' +
				'(e.g. <region>.aws.api.temporal.io:7233).'
		};
	}

	if (isCloudTemporalAddress(config.address) && !hasApiKey) {
		return {
			summary:
				`Temporal address ${config.address} is a Cloud endpoint but TEMPORAL_API_KEY is ` +
				`not set, so authentication will fail.`,
			detail:
				'Set TEMPORAL_API_KEY to a valid Temporal Cloud API key, or point TEMPORAL_ADDRESS\n' +
				'at your local dev server (localhost:7233) to run fully locally.'
		};
	}

	return null;
}

/**
 * Resolve the Temporal configuration a process should actually use, given the
 * address it has committed to talking to.
 *
 * This is the orchestrator-side counterpart to {@link assertTemporalConfig}. A
 * runtime boundary (worker/web) consumes ambient config and cannot tell an
 * intended target from a leak, so it *asserts* and fails loud. The dev
 * orchestrator, by contrast, is the *authority* on which server to run: once it
 * has committed to the local dev server, leaked Cloud credentials simply do not
 * apply — the local server only knows the `default` namespace and takes no API
 * key — so it *normalizes* them away rather than refusing to start.
 *
 * For a local address, a Cloud-looking namespace (one containing a `.`) is reset
 * to `default` and any API key is dropped; a bare local namespace is preserved.
 * Remote addresses pass through unchanged. The result is always coherent for a
 * local address — {@link describeTemporalConfigProblem} returns `null` for it.
 */
export function normalizeTemporalConfigForAddress(config: TemporalConfig): TemporalConfig {
	if (!isLocalTemporalAddress(config.address)) return config;
	const cloudLookingNamespace = config.namespace.includes('.');
	return {
		address: config.address,
		namespace: cloudLookingNamespace ? 'default' : config.namespace,
		apiKey: undefined
	};
}

/**
 * Throws with a clear, multi-line message when the Temporal configuration is
 * incoherent. Call at each boundary that connects to Temporal so the failure is
 * loud and self-explaining rather than a downstream "Internal Error".
 */
export function assertTemporalConfig(config: TemporalConfig): void {
	const problem = describeTemporalConfigProblem(config);
	if (problem) throw new Error(`${problem.summary}\n\n${problem.detail}`);
}
