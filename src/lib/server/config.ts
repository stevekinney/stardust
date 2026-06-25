// Framework-agnostic server configuration — safe to import from Worker (no SvelteKit virtuals).

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
