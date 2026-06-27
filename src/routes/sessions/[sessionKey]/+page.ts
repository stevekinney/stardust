import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
	return {
		sessionKey: params.sessionKey,
		startMessage: url.searchParams.get('start')
	};
};
