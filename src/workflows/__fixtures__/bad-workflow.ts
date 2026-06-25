// @ts-nocheck — fixture intentionally imports unresolvable and forbidden modules.
// Fixture: intentionally violates determinism rules.
// NOT linted by the main `bun run lint` gate (see eslint.config.js fixtures override).
// Linted only by src/workflows/boundary.test.ts to assert specific rule violations.

import { readFileSync } from 'node:fs';
import armorer from 'armorer';

export function badWorkflow() {
	return { readFileSync, armorer };
}
