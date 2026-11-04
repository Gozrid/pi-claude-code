/**
 * Answer box (part of chat-view)
 *
 * After a long round (from sending to its end, LONG_ROUND_MS), the answer also
 * shows in a framed box right above the editor, its bottom edge the editor's top
 * border, so it reads without scrolling the chat. The box is at most two thirds of
 * the terminal high and scrolls: shift+↑/↓ by row, page up/down by page, and the
 * mouse wheel over it (pi's fullscreen mode) instead of the chat. Esc or
 * the next message closes it; the chat behind it keeps the whole answer. While
 * the prompt history or the command list is open, the box gives way to it.
 *
 * PI_ANSWER_BOX_AFTER=<seconds> sets what counts as long (default 90).
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Markdown, matchesKey, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { clampOffset, contentHeight, formatDuration, LONG_ROUND_MS, roundAnswer, wheelRows } from "./answer.ts";
import { barCodeBlocks } from "./code-blocks.ts";
import { borderColor, editorHasFocus, type FrameBottom, frameRow, frameTop, joinEditor } from "./editor-frame.ts";

type Theme = ExtensionContext["ui"]["theme"];

const WIDGET = "answer-box";

const longRoundMs = () => {
	const seconds = Number(process.env.PI_ANSWER_BOX_AFTER);
	return Number.isFinite(seconds) && seconds >= 0 && process.env.PI_ANSWER_BOX_AFTER !== "" ? seconds * 1000 : LONG_ROUND_MS;
};

/** Lists above the editor the box makes room for while they show. */
export interface OtherFrames {
	showing(): boolean;
}

export function answerBox(pi: ExtensionAPI, others: OtherFrames) {
	let tui: TUI | undefined;
	let theme: Theme | undefined;
	let startedAt: number | undefined;
	let box: { markdown: Markdown; title: string } | undefined;
	let offset = 0;
	/** Rows in view and below them, as of the last render; for scrolling and the bottom edge. */
	let height = 1;
	let below = 0;
	let stopInput: (() => void) | undefined;

	const showing = () => !!box && !others.showing();

	const close = () => {
		if (!box) return;
		box = undefined;
		tui?.requestRender();
	};

	const bottom = (): FrameBottom => {
		if (!showing() || !theme) return undefined;
		return { label: theme.fg("dim", below > 0 ? `↓ ${below} more · esc close` : "esc close") };
	};

	const scroll = (rows: number) => {
		offset += rows;
		tui?.requestRender();
	};

	const onInput = (data: string) => {
		if (isKeyRelease(data) || !showing() || !editorHasFocus(tui)) return undefined;
		const page = Math.max(1, height - 1);
		if (matchesKey(data, "shift+up")) scroll(-1);
		else if (matchesKey(data, "shift+down")) scroll(1);
		else if (matchesKey(data, "pageUp")) scroll(-page);
		else if (matchesKey(data, "pageDown")) scroll(page);
		else if (matchesKey(data, "escape")) close();
		else return undefined;
		return { consume: true };
	};

	/** Sets the widget again when the box opens, so it is the last one, right on the editor (see prompt-history.ts). */
	const install = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(WIDGET, (ui, uiTheme) => {
			tui = ui;
			theme = uiTheme;
			return {
				render(width: number): string[] {
					joinEditor(ui, bottom);
					if (!box || others.showing() || width < 8) return [];
					const color = borderColor(ui);
					const lines = box.markdown.render(width - 4);
					height = contentHeight(lines.length, ui.terminal.rows);
					offset = clampOffset(offset, lines.length, height);
					below = lines.length - offset - height;
					const title = `${uiTheme.style("● Answer", { fg: "accent", bold: true })}${uiTheme.fg("dim", ` · ${box.title}`)}`;
					const above = offset > 0 ? uiTheme.fg("dim", `↑ ${offset} more`) : "";
					return [
						frameTop(color, width, title, above),
						...lines.slice(offset, offset + height).map((line) => frameRow(color, width, line)),
					];
				},
				handleMouse(event: TuiMouseEvent) {
					const rows = showing() ? wheelRows(event) : undefined;
					if (rows === undefined) return undefined;
					scroll(rows);
					return { handled: true };
				},
				invalidate() {
					box?.markdown.invalidate();
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		box = undefined;
		startedAt = undefined;
		if (ctx.mode !== "tui") return;
		stopInput?.();
		stopInput = ctx.ui.onTerminalInput(onInput);
		install(ctx);
	});

	// The next message closes the box; the round it starts is timed from here.
	pi.on("input", async (event) => {
		if (!event.streamingBehavior) startedAt = Date.now();
		close();
		return { action: "continue" };
	});

	pi.on("agent_start", async () => {
		startedAt ??= Date.now();
	});

	pi.on("agent_end", async (event, ctx) => {
		const ms = startedAt === undefined ? 0 : Date.now() - startedAt;
		startedAt = undefined;
		if (ms < longRoundMs()) return;
		const text = roundAnswer(event.messages);
		if (!text || !theme) return;
		const markdownTheme = getMarkdownTheme();
		barCodeBlocks(markdownTheme, theme);
		box = { markdown: new Markdown(text, 0, 0, markdownTheme), title: formatDuration(ms) };
		offset = 0;
		if (ctx.mode === "tui") install(ctx);
		tui?.requestRender();
	});

	pi.on("session_shutdown", async () => {
		box = undefined;
		stopInput?.();
		stopInput = undefined;
		tui = undefined;
		theme = undefined;
	});
}
