/**
 * The user's earlier prompts of the session, as a list above the editor: which
 * one is selected, which rows are in view, and how the list grows and shrinks.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/** Rows of the list at most; longer histories scroll. */
export const HISTORY_ROWS = 8;

/** The user's prompts in a session branch, oldest first. */
export function userPrompts(entries: readonly { type: string; message?: unknown }[]): string[] {
	const prompts: string[] = [];
	for (const entry of entries) {
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (entry.type !== "message" || message?.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
					: "";
		if (text.trim()) prompts.push(text.trim());
	}
	return prompts;
}

/** The selection in the list and the window of rows in view; the newest prompt is last. */
export class HistoryBrowser {
	readonly prompts: readonly string[];
	selected: number;
	/** Index of the first prompt in view. */
	top: number;

	constructor(prompts: readonly string[]) {
		this.prompts = prompts;
		this.selected = prompts.length - 1;
		this.top = Math.max(0, prompts.length - HISTORY_ROWS);
	}

	/** Moves the selection by `step` (-1 older, +1 newer); false when it would leave the list. */
	move(step: number): boolean {
		const next = this.selected + step;
		if (next < 0 || next >= this.prompts.length) return false;
		this.selected = next;
		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + HISTORY_ROWS) this.top = this.selected - HISTORY_ROWS + 1;
		return true;
	}

	get current(): string {
		return this.prompts[this.selected] ?? "";
	}

	/** Rows of the full list. */
	get height(): number {
		return Math.min(HISTORY_ROWS, this.prompts.length);
	}

	/** The rows in view, `width` wide, the selected one marked; only the bottom `rows` of them while the list grows or shrinks. */
	lines(theme: Theme, width: number, rows = this.height): string[] {
		const view = this.prompts.slice(this.top, this.top + HISTORY_ROWS).map((prompt, i) => {
			const text = prompt.replace(/\s+/g, " ");
			const line =
				this.top + i === this.selected
					? `${theme.fg("accent", "▸")} ${theme.fg("text", text)}`
					: `  ${theme.fg("muted", text)}`;
			return truncateToWidth(line, width);
		});
		return rows > 0 ? view.slice(-rows) : [];
	}
}

/** The list's height `elapsed` ms into growing (or shrinking) by one row per `msPerRow`. */
export function animatedRows(from: number, to: number, elapsed: number, msPerRow: number): number {
	const steps = msPerRow > 0 ? Math.floor(elapsed / msPerRow) : Number.POSITIVE_INFINITY;
	return from < to ? Math.min(to, from + steps) : Math.max(to, from - steps);
}
