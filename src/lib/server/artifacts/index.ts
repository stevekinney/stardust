export type * from './artifact-store';
export { LocalArtifactStore } from './local-artifact-store';
export { mintToken, verifyToken } from './token';
export { spillLargeOutput } from './spill';
export type { SpillOptions } from './spill';

import { LocalArtifactStore } from './local-artifact-store';
import type { ArtifactStore } from './artifact-store';

/**
 * Return the configured ArtifactStore singleton.
 *
 * In the POC only `LocalArtifactStore` is available. The factory keeps the
 * implementation swappable behind the `ArtifactStore` interface.
 */
export function getArtifactStore(): ArtifactStore {
	return new LocalArtifactStore();
}
