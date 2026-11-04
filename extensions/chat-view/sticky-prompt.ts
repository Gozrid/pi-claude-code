/**
 * Sticky prompt (part of chat-view)
 *
 * In fullscreen mode, the user message the visible part of the chat belongs to
 * stays pinned at the top of the transcript while the answer, thinking and tool
 * output scroll below it, like `position: sticky` in HTML: once the message
 * scrolls out at the top, a copy sticks there; the next user message pushes it
 * out as it comes up, and scrolling back to the message lets it take its own
 * place in the chat again.
 *
 * Regular mode leaves scrolling to the terminal, so there is nothing to pin to.
 *
 * Usage:
 *   /sticky [on|off]   pin the prompt or not (toggles without an argument)
 *
 * PI_STICKY_PROMPT=0 starts with it off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { pinnedRows, type Span } from "./sticky.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** A widget that draws nothing; it only hands over the TUI. */
const WIDGET = "sticky-prompt";
/** At most this many rows of a long message are pinned. */
const MAX_ROWS = 4;

const OSC133 = /\x1b\]133;[ABC]\x07/g;

interface ScrollViewLike extends Component {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly viewportHeight: number;
	children: Component[];
	getContentWidth(width: number): number;
}

function isScrollView(component: unknown): component is ScrollViewLike {
	const c = component as Partial<ScrollViewLike> | undefined;
	return !!c && typeof c.scrollTop === "number" && typeof c.getContentWidth === "function" && Array.isArray(c.children);
}

/** The fullscreen transcript: the primary scroll view of pi's layout. */
function findTranscript(tui: TUI): ScrollViewLike | undefined {
	const primary = (tui as { getPrimaryScrollView?: () => unknown }).getPrimaryScrollView?.();
	if (isScrollView(primary) && primary.primary) return primary;
	const stack: unknown[] = [...tui.children];
	while (stack.length > 0) {
		const node = stack.pop() as { children?: unknown[]; entries?: { component: unknown }[] } | undefined;
		if (isScrollView(node) && node.primary) return node;
		if (Array.isArray(node?.children)) stack.push(...node.children);
		if (Array.isArray(node?.entries)) stack.push(...node.entries.map((e) => e.component));
	}
	return undefined;
}

function isUserMessage(component: Component): boolean {
	// Bundlers may suffix the class name, e.g. UserMessageComponent2.
	return component.constructor.name.startsWith("UserMessageComponent");
}

/** Plain containers render their children one below the other, so rows add up. */
function isPlainContainer(component: Component): component is Component & { children: Component[] } {
	return component.constructor.name.replace(/\d+$/, "") === "Container" && Array.isArray((component as any).children);
}

/** Where each user message sits in the rendered transcript, with its lines. */
function userMessages(document: Component, width: number): (Span & { lines: string[] })[] {
	const found: (Span & { lines: string[] })[] = [];
	let row = 0;
	const walk = (component: Component) => {
		if (isUserMessage(component)) {
			const lines = component.render(width);
			found.push({ start: row, end: row + lines.length, lines });
			row += lines.length;
		} else if (isPlainContainer(component)) {
			for (const child of component.children) walk(child);
		} else {
			row += component.render(width).length;
		}
	};
	walk(document);
	return found;
}

/** Draws the pinned copy at the top of the transcript; nothing while the message is in its place. */
class StickyPrompt implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: () => Theme,
	) {}

	render(width: number): string[] {
		const transcript = findTranscript(this.tui);
		const document = transcript?.children[0];
		if (!transcript || !document || transcript.viewportHeight <= MAX_ROWS) return [];
		const contentWidth = transcript.getContentWidth(width);
		const messages = userMessages(document, contentWidth);
		const pinned = pinnedRows(messages, transcript.scrollTop, MAX_ROWS);
		if (!pinned) return [];
		const message = messages[pinned.index]!;
		let lines = message.lines.map((line) => line.replace(OSC133, ""));
		if (lines.length > MAX_ROWS) {
			lines = lines.slice(0, MAX_ROWS);
			lines[MAX_ROWS - 1] = this.theme().bg("userMessageBg", this.theme().fg("dim", truncateToWidth("  …", contentWidth, "", true)));
		}
		return lines.slice(pinned.hiddenRows).map((line) => truncateToWidth(line, contentWidth));
	}

	invalidate(): void {}
}

export function stickyPrompt(pi: ExtensionAPI) {
	let enabled = process.env.PI_STICKY_PROMPT !== "0";
	let overlay: OverlayHandle | undefined;

	const hide = (ctx: ExtensionContext) => {
		overlay?.hide();
		overlay = undefined;
		try {
			ctx.ui.setWidget(WIDGET, undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};

	const show = (ctx: ExtensionContext) => {
		if (overlay || ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, (tui, theme) => {
			if (tui.mode === "fullscreen" && !overlay) {
				overlay = tui.showOverlay(new StickyPrompt(tui, () => theme), {
					anchor: "top-left",
					row: 0,
					col: 0,
					width: "100%",
					nonCapturing: true,
				});
			}
			return { render: () => [], invalidate() {} };
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) show(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => hide(ctx));

	pi.registerCommand("sticky", {
		description: "Pin the user message above its answer while scrolling: /sticky [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			if (enabled) show(ctx);
			else hide(ctx);
			ctx.ui.notify(`Sticky prompt ${enabled ? "on" : "off"}`, "info");
		},
	});
}
