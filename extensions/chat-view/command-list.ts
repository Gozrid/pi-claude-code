/**
 * Command list (part of chat-view)
 *
 * pi's suggestions while typing (/commands, and files after @ or Tab) move from
 * below the editor into a frame right above it, like the prompt history: up to
 * eight rows, the counter in the top edge, the bottom edge the editor's top
 * border, growing and shrinking row by row. pi still does the searching,
 * selecting, Tab and Enter; only where and how the list shows changes.
 *
 * The mouse (fullscreen mode) works on the frame as on pi's own list: a click on
 * a suggestion applies it like Tab, the wheel moves the selection.
 *
 * pi has no hook for this, so the editor instance's render is wrapped to leave
 * its suggestion rows out, and the widget draws pi's list itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { borderColor, findEditor, frameRow, frameRowAt, frameTop, joinEditor } from "./editor-frame.ts";
import { animatedRows, HISTORY_ROWS } from "./history.ts";

const WIDGET = "command-list";
const MS_PER_ROW = 20;
const STATIC = process.env.PI_HISTORY_STATIC === "1";
const WRAPPED = Symbol.for("pi-claude-code.chat-view.commandList");

/** The fields of pi's editor the list reads: its suggestion list and how many rows that took. */
interface SuggestingEditor {
	render(width: number): string[];
	getText(): string;
	autocompleteState?: unknown;
	autocompleteList?: SuggestionList;
	renderedAutocompleteHeight?: number;
	setAutocompleteMaxVisible?(rows: number): void;
	[WRAPPED]?: true;
}

/** pi's suggestion list (a SelectList): it draws the rows and takes the mouse on them. */
interface SuggestionList {
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/**
 * Hands a mouse event on the frame to pi's list, in the list's own coordinates:
 * a click on row `n` of `rows` shown is a click on its row `n`, the wheel moves
 * the selection. The editor keeps the focus.
 */
export function listMouse(list: SuggestionList, event: TuiMouseEvent, rows: number): TuiMouseEventResult | undefined {
	if (event.type === "wheel") {
		list.handleMouse?.({ ...event, x: 0, y: 0, width: Math.max(1, event.width - 4), height: rows });
		return { handled: true };
	}
	const row = frameRowAt(event, rows);
	if (row === undefined) return undefined;
	const result = list.handleMouse?.({ ...event, x: Math.max(0, event.x - 2), y: row, width: Math.max(1, event.width - 4), height: rows });
	if (!result) return event.type === "press" || event.type === "release" ? { handled: true, render: false } : undefined;
	const { focus: _focus, ...rest } = result;
	return { ...rest, handled: true };
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const plain = (text: string) => text.replace(ANSI, "");

/** pi's list rows without its counter line, and the counter ("1/8") if there is one. */
export function splitCounter(rows: readonly string[]): { rows: string[]; counter?: string } {
	const last = rows.length > 0 ? plain(rows[rows.length - 1]!).trim() : "";
	const match = /^\((\d+\/\d+)\)$/.exec(last);
	return match ? { rows: rows.slice(0, -1), counter: match[1] } : { rows: [...rows] };
}

/** The selected row's arrow as the history list's marker. */
const marked = (row: string) => row.replace("→", "▸");

/** Leaves pi's suggestion rows out of the editor; the widget shows them above it. */
function wrap(editor: SuggestingEditor): void {
	const original = editor.render.bind(editor);
	editor.setAutocompleteMaxVisible?.(HISTORY_ROWS);
	editor.render = (width: number) => {
		const lines = original(width);
		const suggestions = editor.renderedAutocompleteHeight ?? 0;
		return suggestions > 0 ? lines.slice(0, lines.length - suggestions) : lines;
	};
	editor[WRAPPED] = true;
}

export interface CommandListState {
	showing(): boolean;
}

export function commandList(pi: ExtensionAPI): CommandListState {
	let tui: TUI | undefined;
	let ctx: ExtensionContext | undefined;
	/** The rows last shown, kept while the list shrinks away. */
	let last: { rows: string[]; counter?: string; title: string } | undefined;
	let from = 0;
	let target = 0;
	let since = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** pi's list while it is open, for the mouse. */
	let openList: SuggestionList | undefined;

	const shown = () => (STATIC ? target : animatedRows(from, target, Date.now() - since, MS_PER_ROW));
	const showing = () => shown() > 0;

	const animateTo = (rows: number) => {
		if (rows === target) return;
		from = shown();
		target = rows;
		since = Date.now();
		if (STATIC || timer) return;
		timer = setInterval(() => {
			tui?.requestRender();
			if (shown() !== target) return;
			clearInterval(timer);
			timer = undefined;
		}, MS_PER_ROW);
		timer.unref?.();
	};

	/** Sets the widget (again), so it is the last one, right on the editor (see prompt-history.ts). */
	const install = (context: ExtensionContext) => {
		context.ui.setWidget(WIDGET, (ui, theme) => {
			tui = ui;
			return {
				render(width: number): string[] {
					const editor = findEditor(ui) as SuggestingEditor | undefined;
					if (!editor) return [];
					if (!editor[WRAPPED]) wrap(editor);
					joinEditor(ui, () => (showing() ? {} : undefined));
					const list = editor.autocompleteState ? editor.autocompleteList : undefined;
					openList = list;
					if (list) {
						const opening = target === 0;
						const { rows, counter } = splitCounter(list.render(width - 4));
						const title = editor.getText().trimStart().startsWith("/") ? "Commands" : "Files";
						last = { rows: rows.map(marked), counter, title };
						animateTo(rows.length);
						// Opening: set the widget again once this frame is drawn, to be the last one.
						if (opening && ctx) setTimeout(() => ctx && install(ctx), 0);
					} else animateTo(0);
					const rows = shown();
					if (!last || rows === 0) return [];
					const color = borderColor(ui);
					const note = last.counter ? theme.fg("dim", last.counter) : "";
					// Fewer suggestions than rows while it shrinks: empty rows fold away below them.
					const view = [...last.rows, ...Array<string>(Math.max(0, rows - last.rows.length)).fill("")].slice(0, rows);
					return [frameTop(color, width, theme.fg("muted", last.title), note), ...view.map((row) => frameRow(color, width, row))];
				},
				invalidate() {},
				handleMouse(event: TuiMouseEvent) {
					// Only on the full list, not while it grows or shrinks.
					if (!openList || !last || shown() !== target) return undefined;
					return listMouse(openList, event, last.rows.length);
				},
			};
		});
	};

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		last = undefined;
		from = target = 0;
		if (context.mode === "tui") install(context);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx = undefined;
		tui = undefined;
	});

	return { showing };
}
