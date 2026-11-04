/**
 * How a dialog opens (the /usage dialog of usage-graph, the wish popup of
 * pi-bridge), in the style of the status line's mode switch:
 *
 *   1. the frame unfolds from the middle of the screen to its full size while
 *      the chat behind it darkens (UNFOLD_MS),
 *   2. the title is typed into the top border behind a block cursor, then a
 *      shine sweeps across it (TITLE_MS); meanwhile the content appears row by
 *      row from the top,
 *   3. /usage: the graphs build up, starting when the frame is unfolded.
 *
 * Glide lets an open dialog grow or shrink to a new size instead of jumping.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The parts of the theme the title needs. */
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold" | "inverse">;

/** 0-1 → 0-1, fast at first and slowing down towards the end. */
export function easeOut(t: number): number {
	const x = Math.max(0, Math.min(1, t));
	return 1 - (1 - x) ** 3;
}

export const UNFOLD_MS = 260;
export const TITLE_MS = 520;
/** Share of TITLE_MS spent typing; the rest is the shine. */
const TYPING_SHARE = 0.55;
/** The frame starts this small (columns, rows incl. borders). */
const START_WIDTH = 12;
const START_ROWS = 2;

/** Total length of the opening. */
export const OPENING_MS = UNFOLD_MS + TITLE_MS;

/** Width and rows of the frame `elapsed` ms after opening; the full size once unfolded. */
export function unfoldedSize(elapsed: number, width: number, rows: number): { width: number; rows: number } {
	const t = easeOut(elapsed / UNFOLD_MS);
	return {
		width: Math.max(Math.min(width, START_WIDTH), Math.round(START_WIDTH + (width - START_WIDTH) * t)),
		rows: Math.max(Math.min(rows, START_ROWS), Math.round(START_ROWS + (rows - START_ROWS) * t)),
	};
}

/** How many of `count` content rows show `elapsed` ms after opening: none while unfolding, then row by row. */
export function shownRows(elapsed: number, count: number): number {
	if (elapsed < UNFOLD_MS) return 0;
	return Math.min(count, Math.ceil(((elapsed - UNFOLD_MS) / (TITLE_MS * TYPING_SHARE)) * count));
}

/**
 * The title `elapsed` ms after opening: nothing while the frame unfolds, then
 * typed in behind a block cursor, then lit by a three-cell shine moving
 * across; plain bold afterwards. Always as wide as the title, so the border
 * does not jump.
 */
export function openingTitle(theme: Theme, text: string, elapsed: number): string {
	const plain = (s: string) => theme.bold(theme.fg("accent", s));
	const t = elapsed - UNFOLD_MS;
	if (t >= TITLE_MS) return theme.bold(text);
	const chars = Array.from(text);
	if (t < 0) return " ".repeat(chars.length);
	const progress = t / TITLE_MS;
	if (progress < TYPING_SHARE) {
		const typed = Math.min(chars.length, Math.floor((progress / TYPING_SHARE) * (chars.length + 1)));
		const cursor = typed < chars.length ? theme.inverse(plain(chars[typed])) : "";
		const rest = " ".repeat(Math.max(0, chars.length - typed - 1));
		return `${plain(chars.slice(0, typed).join(""))}${cursor}${rest}`;
	}
	const shine = 3;
	const sweep = (progress - TYPING_SHARE) / (1 - TYPING_SHARE);
	const start = Math.round(sweep * (chars.length + shine)) - shine;
	const before = chars.slice(0, Math.max(0, start)).join("");
	const lit = chars.slice(Math.max(0, start), Math.max(0, start + shine)).join("");
	const after = chars.slice(Math.max(0, start + shine)).join("");
	return `${plain(before)}${lit ? theme.bold(theme.fg("text", lit)) : ""}${plain(after)}`;
}

/** How long the open dialog takes to grow or shrink to a new size. */
export const RESIZE_MS = 220;

/**
 * One dimension of the open dialog (rows or columns) that glides to a new
 * size instead of jumping: `at()` gives the size to draw now for the size the
 * content wants; a change of that target starts a new glide from where the
 * size stands.
 */
export class Glide {
	private from = 0;
	private to: number | undefined;
	private start = 0;

	at(target: number, now: number): number {
		if (this.to === undefined) {
			this.from = this.to = target;
			this.start = now - RESIZE_MS;
		} else if (target !== this.to) {
			this.from = this.current(now);
			this.to = target;
			this.start = now;
		}
		return this.current(now);
	}

	/** Whether the size is still gliding at `now`. */
	moving(now: number): boolean {
		return this.to !== undefined && now - this.start < RESIZE_MS;
	}

	private current(now: number): number {
		const to = this.to ?? 0;
		const t = (now - this.start) / RESIZE_MS;
		return t >= 1 ? to : Math.round(this.from + (to - this.from) * easeOut(t));
	}
}
