import type { SessionRow } from '$lib/types';

/**
 * Shared reactive session list. The sessions page loads it on mount; the
 * command palette reuses the same data lazily instead of fetching again.
 */
export class SessionsStore {
	sessions = $state.raw<SessionRow[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);
	#loadedOnce = false;

	/** Active (non-archived) sessions. */
	get active(): SessionRow[] {
		return this.sessions.filter((session) => !session.archivedAt);
	}

	/** Fetch the session list from the API, replacing the cached rows. */
	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			const response = await fetch('/api/sessions');
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { sessions: SessionRow[] };
			this.sessions = body.sessions;
			this.#loadedOnce = true;
		} catch (caught) {
			this.error = parseErrorMessage(caught);
		} finally {
			this.loading = false;
		}
	}

	/** Fetch only if no load has succeeded yet — used by consumers that tolerate stale data. */
	async ensureLoaded(): Promise<void> {
		if (this.#loadedOnce || this.loading) return;
		await this.load();
	}
}

function parseErrorMessage(caught: unknown): string {
	if (!(caught instanceof Error)) return 'Failed to load sessions';
	try {
		const parsed = JSON.parse(caught.message) as { message?: string };
		return parsed.message ?? caught.message;
	} catch {
		return caught.message;
	}
}

export const sessionsStore = new SessionsStore();
