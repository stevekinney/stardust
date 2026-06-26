import { db } from '../../../../../../lib/server/db';
import {
	encodeServerSentEvents,
	readStreamEventsAfterCursor
} from '../../../../../../lib/server/stream';
import type { RequestHandler } from './$types';

function readCursor(request: Request, url: URL): number {
	const rawCursor = url.searchParams.get('cursor') ?? request.headers.get('last-event-id') ?? '0';
	const cursor = Number(rawCursor);
	return Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

export const GET: RequestHandler = async ({ params, request, url }) => {
	const replay = await readStreamEventsAfterCursor(db, {
		runId: params.runId,
		afterId: readCursor(request, url)
	});

	return new Response(encodeServerSentEvents(replay), {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
