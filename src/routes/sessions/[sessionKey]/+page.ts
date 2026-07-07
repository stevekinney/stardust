import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
	return {
		sessionKey: params.sessionKey,
		startMessage: url.searchParams.get('start'),
		// Set by "New session" (hero button / ⌘K palette) when navigating to a
		// session that was just minted and has no first message yet — see
		// $lib/session-page-bootstrap.ts for why this matters (BUG-001).
		fresh: url.searchParams.get('fresh') === '1'
	};
};
