import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../config';

let _client: Client | null = null;

/** Returns a shared Temporal Client, creating it on first call. */
export async function getTemporalClient(): Promise<Client> {
	if (_client) return _client;
	const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
	_client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
	return _client;
}
