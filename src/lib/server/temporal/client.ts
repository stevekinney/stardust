import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_API_KEY, TEMPORAL_NAMESPACE } from '../config';
import { assertTemporalConfig } from './config-check';

let _client: Client | null = null;

/** Returns a shared Temporal Client, creating it on first call. */
export async function getTemporalClient(): Promise<Client> {
	if (_client) return _client;
	// Fail loud at the boundary rather than emitting an opaque error downstream when
	// leaked Cloud credentials have overridden the local .env configuration.
	assertTemporalConfig({
		address: TEMPORAL_ADDRESS,
		namespace: TEMPORAL_NAMESPACE,
		apiKey: TEMPORAL_API_KEY
	});
	const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
	_client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
	return _client;
}
