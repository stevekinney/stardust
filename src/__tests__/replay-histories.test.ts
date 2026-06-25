// Placeholder for Workflow replay history smoke tests.
// Replay tests run real recorded histories against current Workflow code to catch
// determinism regressions. Populated in T3 when AgentSessionWorkflow is implemented.
// See: https://docs.temporal.io/develop/typescript/testing#replay-test

import { describe, it } from 'vitest';

// Required export — temporal/replay-history-smoke-test-hook verifies this exists.
// Populated in T3 when Workflow histories are recorded.
export async function runReplayHistorySmokeTest() {
	// no-op until replay histories are recorded
}

describe('Workflow replay histories', () => {
	it.todo('replay AgentSessionWorkflow histories against current code');
});
