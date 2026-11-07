/**
 * Steering and queued messages while the agent works: which are waiting, and
 * how they are shown above the editor together with the keys to send them.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/**
 * pi.events channel: chat-crab says whether it shows the key hints beside the
 * crab (true) or the panel has to draw its own row again (false).
 */
export const HINTS_HOST_CHANNEL = "chat-crab:hints-host";

/** pi.events channel for the hints chat-crab shows; the payload is QueueHints, or undefined while there are none. */
export const QUEUE_HINTS_CHANNEL = "chat-view:queue-hints";

/** A ready-styled hints line and its width in columns. */
export interface QueueHints {
	line: string;
	width: number;
}

/** "steer" arrives after the current step, "followUp" once the agent is done. */
export type QueueKind = "steer" | "followUp";

export interface Queued {
	kind: QueueKind;
	text: string;
	/** When it was sent; pi queues it a moment later. */
	at: number;
}

/** How long a new message counts as waiting before pi has it in its queue. */
const SETTLE_MS = 1000;

/** The keys for steering, queueing, editing the queue and stopping, as pi displays them. */
export interface QueueKeys {
	steer: string;
	/** Stops the current step and sends right away. */
	now: string;
	queue: string;
	edit: string;
	stop: string;
}

/** The messages waiting for the agent, in the order pi delivers them: steering first. */
export class MessageQueue {
	private items: Queued[] = [];

	get messages(): readonly Queued[] {
		return [...this.items.filter((m) => m.kind === "steer"), ...this.items.filter((m) => m.kind === "followUp")];
	}

	add(kind: QueueKind, text: string, now = Date.now()): void {
		this.items.push({ kind, text, at: now });
	}

	/**
	 * A user message reached the chat: drops the waiting message with that text,
	 * or, if a template or another extension changed it on the way, the next one in line.
	 */
	delivered(text: string): void {
		if (this.items.length === 0) return;
		const exact = this.items.findIndex((m) => m.text.trim() === text.trim());
		const next = this.messages[0]!;
		this.items.splice(exact >= 0 ? exact : this.items.indexOf(next), 1);
	}

	/** pi holds nothing anymore: drops all but the messages it has not had time to queue yet. */
	settle(now = Date.now()): void {
		this.items = this.items.filter((m) => now - m.at < SETTLE_MS);
	}

	clear(): void {
		this.items = [];
	}
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A key as symbols, for the compact hints: "option+enter" → "⌥↵". */
export function keySymbol(key: string): string {
	return key
		.split("+")
		.map((part) => KEY_SYMBOLS[part.toLowerCase()] ?? part)
		.join("");
}

const KEY_SYMBOLS: Record<string, string> = {
	ctrl: "⌃",
	control: "⌃",
	option: "⌥",
	alt: "⌥",
	shift: "⇧",
	cmd: "⌘",
	super: "⌘",
	enter: "↵",
	return: "↵",
	escape: "esc",
	up: "↑",
	down: "↓",
};

/** What a hint does when it is clicked, as its key would. */
export type QueueAction = "steer" | "now" | "queue" | "edit" | "stop";

/** The hints in order: what each does, its key and the words after it. */
function hintItems(keys: QueueKeys, waiting: boolean, compact: boolean): { action: QueueAction; key: string; what: string }[] {
	const item = (action: QueueAction, what: string) => ({ action, key: compact ? keySymbol(keys[action]) : keys[action], what });
	return [
		item("steer", compact ? "steer" : "steer (after this step)"),
		item("now", compact ? "now" : "steer now"),
		item("queue", compact ? "queue" : "queue (when done)"),
		...(waiting ? [item("edit", compact ? "edit" : "edit waiting")] : []),
		item("stop", "stop"),
	];
}

const HINT_SEPARATOR = " · ";

/**
 * The keys for steering, queueing, editing and stopping, in one line. Compact,
 * the keys are symbols and the words short, so it fits beside the crab.
 */
export function hintsLine(theme: Theme, keys: QueueKeys, waiting: boolean, compact = false): string {
	const hints = hintItems(keys, waiting, compact).map(
		({ key, what }) => `${theme.style(key, { fg: "muted", bold: true })} ${theme.fg("dim", what)}`,
	);
	return `${hints.join(theme.fg("dim", HINT_SEPARATOR))} `;
}

/** The hint at `column` of hintsLine's text (0 for its first column), if any. */
export function hintAt(keys: QueueKeys, waiting: boolean, column: number, compact = false): QueueAction | undefined {
	let start = 0;
	for (const { action, key, what } of hintItems(keys, waiting, compact)) {
		const end = start + visibleWidth(`${key} ${what}`);
		if (column >= start && column < end) return action;
		start = end + visibleWidth(HINT_SEPARATOR);
	}
	return undefined;
}

/**
 * What a click at (`x`, `y`) on the rows of queueLines does: a waiting message
 * goes back to the editor (edit), a hint does what its key does.
 */
export function queueClick(
	keys: QueueKeys,
	waiting: number,
	hints: boolean,
	hintsWidth: number,
	width: number,
	x: number,
	y: number,
): QueueAction | undefined {
	if (y >= 0 && y < waiting) return "edit";
	if (!hints || y !== waiting) return undefined;
	return hintAt(keys, waiting > 0, x - (width - hintsWidth));
}

/**
 * The rows above the editor: each waiting message with its kind, then the keys,
 * aligned right. Shown only while the agent works; the keys row also when nothing
 * waits yet, unless `hints` is false (chat-crab shows them). `hintsWidth` is the
 * width of the keys row's text.
 */
export function queueLines(
	theme: Theme,
	messages: readonly Queued[],
	keys: QueueKeys,
	width: number,
	hints = true,
): { lines: string[]; hintsWidth: number } {
	const lines = messages.map((m) => {
		const label =
			m.kind === "steer"
				? theme.style("↪ Steer ", { fg: "accent", bold: true })
				: theme.style("◷ Queued", { fg: "muted", bold: true });
		return truncateToWidth(` ${label} ${theme.fg("text", oneLine(m.text))}`, width);
	});
	if (!hints) return { lines, hintsWidth: 0 };
	const row = truncateToWidth(hintsLine(theme, keys, messages.length > 0), width);
	const hintsWidth = visibleWidth(row);
	lines.push(" ".repeat(Math.max(0, width - hintsWidth)) + row);
	return { lines, hintsWidth };
}
