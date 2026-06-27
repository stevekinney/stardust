import type { ToolCallInput } from '@src/lib/types';

/**
 * Minimum query-parameter value length (characters) that triggers the
 * exfiltration heuristic on `web.fetch` calls.  Values this long are a strong
 * signal that the model is trying to smuggle captured data out-of-band.
 */
const EXFILTRATION_PARAM_LENGTH_THRESHOLD = 200;

/**
 * High-precision patterns for the most common prompt-injection phrases.
 * Each pattern anchors on a complete phrase to keep false-positive risk low:
 * writing a document *about* injection should not trip the guard.
 */
const INJECTION_PHRASE_PATTERNS: ReadonlyArray<RegExp> = [
	// Classic override: "ignore [all] previous/prior instructions/prompts/directives"
	/ignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?|directives?|context)/i,
	// "disregard [all] previous/prior …"
	/disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?|directives?|context)/i,
	// "forget [all] previous/prior …"
	/forget\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?|directives?|context)/i,
	// New role/system injection
	/new\s+system\s+(?:prompt|instructions?|context|message)/i,
	// "[SYSTEM]:" or "[INST]" delimiters used in some model prompt formats
	/\[system\]\s*:/i,
	/\[inst\]/i,
	// Identity override: "you are now a …"
	/you\s+are\s+now\s+(?:a|an)\s+/i
];

/**
 * Checks whether a `web.fetch` URL contains query-parameter values long enough
 * to plausibly be base64-encoded captured data.  This is a heuristic — it will
 * not catch every exfiltration attempt, but it surfaces the most obvious ones.
 */
function hasExfiltrationUrl(call: ToolCallInput): boolean {
	if (call.name !== 'web.fetch') return false;
	const args = call.arguments as Record<string, unknown>;
	const rawUrl = typeof args.url === 'string' ? args.url : '';

	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}

	for (const value of parsed.searchParams.values()) {
		if (value.length >= EXFILTRATION_PARAM_LENGTH_THRESHOLD) return true;
	}
	return false;
}

/**
 * Scans a tool call's serialized arguments for prompt-injection phrases and
 * exfiltration patterns.
 *
 * Returns a human-readable reason string if the call is flagged, or `null` if
 * the call appears clean.  Called inside `validateToolCall` after schema
 * validation and before the approval / allowed branch.
 */
export function detectPromptInjection(call: ToolCallInput): string | null {
	const serialized = JSON.stringify(call.arguments);

	for (const pattern of INJECTION_PHRASE_PATTERNS) {
		if (pattern.test(serialized)) {
			return `Prompt injection detected in ${call.name} arguments`;
		}
	}

	if (hasExfiltrationUrl(call)) {
		return `Possible exfiltration detected in ${call.name} URL (oversized query parameter)`;
	}

	return null;
}
