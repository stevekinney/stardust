import type { SessionRow } from '$lib/types';

/** Human-readable label for a session; falls back to the session key when no name is set. */
export function displayLabel(session: SessionRow): string {
	return session.name ?? session.sessionKey;
}

/** Maps a session status to the CSS class(es) that color its status dot. */
export function statusDotClass(status: string): string {
	switch (status) {
		case 'complete':
		case 'recovered':
			return 'dot-success';
		case 'failed':
			return 'dot-danger';
		case 'cancelled':
			return 'dot-muted';
		case 'running':
			return 'dot-accent dot-pulse';
		case 'streaming':
		case 'loading':
			return 'dot-info dot-pulse';
		case 'waiting_approval':
		case 'disconnected':
			return 'dot-warning dot-pulse';
		case 'active':
			return 'dot-success dot-pulse';
		default:
			return 'dot-muted';
	}
}

/** Formats a status string for display by replacing underscores with spaces. */
export function formatStatus(status: string): string {
	return status.replace(/_/g, ' ');
}

/** Formats an ISO date string as a short relative time (e.g. "5m ago"). */
export function relativeTime(dateString: string): string {
	const now = Date.now();
	const then = new Date(dateString).getTime();
	const seconds = Math.floor((now - then) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
