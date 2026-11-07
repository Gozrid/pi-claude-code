/**
 * The answer of a long round, for the answer box: which text it shows, how long
 * the round took, and which of its rows are in view.
 */

import { groupMessage } from "./grouping.ts";

/** Rounds at least this long get the answer box; PI_ANSWER_BOX_AFTER overrides it in seconds. */
export const LONG_ROUND_MS = 90_000;

/**
 * The answer of a finished round: what the last assistant message says after its
 * last thought or tool call. Nothing when the round was stopped, failed or ended
 * on a tool call.
 */
export function roundAnswer(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
		| { content?: unknown; stopReason?: string }
		| undefined;
	if (!last || !Array.isArray(last.content) || last.stopReason === "aborted" || last.stopReason === "error") return undefined;
	return groupMessage(last.content).answer;
}

/** "2m 10s", "45s". */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Content rows of the box: as many as the answer has, the whole box at most two thirds of the terminal. */
export function contentHeight(total: number, terminalRows: number): number {
	return Math.max(1, Math.min(total, Math.floor((terminalRows * 2) / 3) - 1));
}

/** The first row in view, kept within the answer. */
export function clampOffset(offset: number, total: number, height: number): number {
	return Math.max(0, Math.min(offset, total - height));
}

/**
 * Rows the mouse wheel scrolls the box by while the pointer is over it; undefined
 * for other mouse events. The box keeps every wheel event over it, also at its
 * top or bottom, so the chat behind it does not scroll instead.
 */
/** The close button drawn at the right end of the box's top edge: "✕ ─╮". */
export const CLOSE_BUTTON = "✕";

/**
 * Whether a mouse event is a left click on the close button: the top row, on
 * the ✕ or the cell next to it, of a box `width` wide.
 */
export function closeClicked(event: { type: string; button?: string; x: number; y: number }, width: number): boolean {
	return event.type === "click" && event.button === "left" && event.y === 0 && event.x >= width - 5 && event.x <= width - 3;
}

export function wheelRows(event: { type: string; wheelDelta?: number }): number | undefined {
	return event.type === "wheel" ? (event.wheelDelta ?? 0) : undefined;
}
