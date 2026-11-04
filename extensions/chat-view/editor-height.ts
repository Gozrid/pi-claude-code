/**
 * Editor height (part of chat-view)
 *
 * When the editor gets more or fewer rows (a new line, a long prompt from the
 * history, sending), it grows or shrinks one row per MS_PER_ROW instead of
 * jumping. While it grows, the rows around the cursor show; while it shrinks,
 * empty rows fold away above the bottom border.
 *
 * pi has no hook for this, so the editor instance's render is wrapped (a replaced
 * editor is wrapped on the next frame). PI_EDITOR_STATIC=1 turns it off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import { findEditor } from "./editor-frame.ts";
import { animatedRows } from "./history.ts";

const WIDGET = "editor-height";
const MS_PER_ROW = 20;
const STATIC = process.env.PI_EDITOR_STATIC === "1";
const WRAPPED = Symbol.for("pi-claude-code.chat-view.editorHeight");

/** The fields of pi's editor the animation reads: how many text and suggestion rows it just rendered. */
interface EditorRows {
	render(width: number): string[];
	renderedVisibleLineCount?: number;
	renderedAutocompleteHeight?: number;
	[WRAPPED]?: true;
}

/**
 * The text rows to draw: `shown` of them, out of the editor's `rows`. Growing keeps
 * the cursor's row in view, preferring the bottom; shrinking pads with empty rows.
 */
export function animatedText(rows: readonly string[], shown: number): string[] {
	if (shown >= rows.length) return [...rows, ...Array<string>(shown - rows.length).fill("")];
	const cursor = rows.findIndex((row) => row.includes(CURSOR_MARKER));
	const end = Math.max(shown, cursor >= 0 ? cursor + 1 : rows.length);
	return rows.slice(end - shown, end);
}

function wrap(editor: EditorRows, tui: TUI): void {
	const original = editor.render.bind(editor);
	let from = -1;
	let target = -1;
	let since = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	editor.render = (width: number) => {
		const lines = original(width);
		const suggestions = editor.renderedAutocompleteHeight ?? 0;
		const count = editor.renderedVisibleLineCount ?? lines.length - 2 - suggestions;
		if (count < 1 || lines.length < count + 2) return lines;
		const now = Date.now();
		const shown = () => animatedRows(from, target, Date.now() - since, MS_PER_ROW);
		if (target < 0) from = target = count;
		if (count !== target) {
			from = shown();
			target = count;
			since = now;
			if (!timer) {
				timer = setInterval(() => {
					tui.requestRender();
					if (shown() !== target && timer) return;
					clearInterval(timer);
					timer = undefined;
				}, MS_PER_ROW);
				timer.unref?.();
			}
		}
		const rows = shown();
		if (rows === count) return lines;
		const text = lines.slice(1, 1 + count);
		return [lines[0]!, ...animatedText(text, rows), ...lines.slice(1 + count)];
	};
	editor[WRAPPED] = true;
}

export function editorHeight(pi: ExtensionAPI) {
	if (STATIC) return;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// A widget that draws nothing; it finds the editor before it renders, each frame.
		ctx.ui.setWidget(WIDGET, (tui) => ({
			render: () => {
				const editor = findEditor(tui) as EditorRows | undefined;
				if (editor && !editor[WRAPPED]) wrap(editor, tui);
				return [];
			},
			invalidate() {},
		}));
	});
}
