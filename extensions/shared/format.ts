/**
 * Formatting shared by the extensions: durations, token counts, shortened text.
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

/** Time until a reset, e.g. "3hr 16m" or "1d 2hr". */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.floor(ms / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `${days}d ${hours}hr`;
	return hours > 0 ? `${hours}hr ${minutes % 60}m` : `${minutes % 60}m`;
}

/** Time something took, e.g. "42s" or "1m 12s". */
export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
