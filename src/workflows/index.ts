// Temporal Workflow entrypoint — determinism boundary enforced by eslint-plugin-temporal.
// Only import from @temporalio/workflow and serializable types (src/lib/types).
// Never import Node APIs, src/lib/server/**, armorer, or conversationalist here.

export {};
