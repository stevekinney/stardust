import { localDataPaths } from '$lib/server/config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	localDataPaths: localDataPaths()
});
