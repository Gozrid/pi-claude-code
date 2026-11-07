/**
 * A frame above the editor whose bottom edge is the editor's own top border:
 * the side lines bend into it (╰ … ╯). Used by the prompt history and the
 * answer box, which sit right above the editor.
 *
 * pi has no hook for the editor's border, so the editor instance's render is
 * wrapped; it asks the frames above whether one is open. The frame takes the
 * editor's border colour, which follows the thinking level.
 */

import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** What an open frame wants on its bottom edge; undefined while it is closed. */
export type FrameBottom = { label?: string } | undefined;

interface EditorLike {
	addToHistory(text: string): void;
	borderColor?: (text: string) => string;
	render(width: number): string[];
}

const WRAPPED = Symbol.for("pi-claude-code.chat-view.editorFrame");

const isEditor = (node: unknown): node is EditorLike =>
	typeof (node as { addToHistory?: unknown } | null)?.addToHistory === "function";

/** pi's editor, or an extension's replacement of it, somewhere in the TUI. */
export function findEditor(tui: TUI): EditorLike | undefined {
	const stack: unknown[] = [...tui.children];
	while (stack.length > 0) {
		const node = stack.pop() as { children?: unknown[] } | undefined;
		if (isEditor(node)) return node;
		if (Array.isArray(node?.children)) stack.push(...node.children);
	}
	return undefined;
}

/**
 * The editor has the keys. Overlays that don't take focus (other extensions draw
 * some) are fine, so only where pi can't tell the focus does any overlay count.
 */
export function editorHasFocus(tui: TUI | undefined): boolean {
	if (!tui) return false;
	const focused = (tui as Partial<{ getFocusedComponent(): unknown }>).getFocusedComponent;
	return focused ? isEditor(focused.call(tui)) : !tui.hasOverlay();
}

/** The editor's border colour, or plain text before an editor is found. */
export function borderColor(tui: TUI): (text: string) => string {
	const editor = findEditor(tui);
	return editor?.borderColor ? editor.borderColor.bind(editor) : (text) => text;
}

/**
 * The content row (0 for the first) a mouse event inside a frame of `rows` rows
 * is on: below the top edge, between the side lines; undefined elsewhere.
 */
export function frameRowAt(event: { x: number; y: number; width: number }, rows: number): number | undefined {
	const row = event.y - 1;
	if (row < 0 || row >= rows || event.x < 1 || event.x > event.width - 2) return undefined;
	return row;
}

/** What of pi's editor (CustomEditor) the mouse uses to do what its keys do. */
interface ActingEditor {
	submitValue?(): void;
	onEscape?: () => void;
	actionHandlers?: Map<string, () => void>;
}

/**
 * Does in pi's editor what one of its keys does: "submit" is enter, otherwise an
 * app action such as "app.message.followUp" or "app.interrupt". False when the
 * editor has no such handler (an editor replaced by another extension).
 */
export function editorAction(tui: TUI | undefined, action: string): boolean {
	const editor = tui ? (findEditor(tui) as (EditorLike & ActingEditor) | undefined) : undefined;
	if (!editor) return false;
	const handler =
		action === "submit"
			? editor.submitValue?.bind(editor)
			: action === "app.interrupt"
				? (editor.onEscape ?? editor.actionHandlers?.get(action))
				: editor.actionHandlers?.get(action);
	if (typeof handler !== "function") return false;
	handler();
	return true;
}

/** The frame's top edge, with a title at the left and an optional note at the right. */
export function frameTop(color: (text: string) => string, width: number, title: string, note = ""): string {
	const right = note ? ` ${note} ${color("─╮")}` : color("╮");
	const fill = Math.max(0, width - visibleWidth(`╭─ ${title} `) - visibleWidth(right));
	return truncateToWidth(`${color("╭─ ")}${title} ${color("─".repeat(fill))}${right}`, width);
}

/** A content row between the side lines, padded to the full width. */
export function frameRow(color: (text: string) => string, width: number, line: string): string {
	const inner = Math.max(0, width - 4);
	const text = truncateToWidth(line, inner);
	return `${color("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${color("│")}`;
}

/**
 * Makes the editor's top border the bottom edge of whichever frame `bottom` reports
 * open. Wraps the current editor once; a replaced editor is wrapped on the next call.
 */
export function joinEditor(tui: TUI, bottom: () => FrameBottom): void {
	const editor = findEditor(tui) as (EditorLike & { [WRAPPED]?: (() => FrameBottom)[] }) | undefined;
	if (!editor) return;
	if (!editor[WRAPPED]) {
		const frames: (() => FrameBottom)[] = [];
		editor[WRAPPED] = frames;
		const original = editor.render.bind(editor);
		editor.render = (width: number) => {
			const lines = original(width);
			const open = frames.map((frame) => frame()).find((frame) => frame !== undefined);
			if (!open || lines.length === 0 || width < 2) return lines;
			const color = editor.borderColor?.bind(editor) ?? ((text: string) => text);
			const label = open.label ? ` ${open.label} ` : "";
			const fill = Math.max(0, width - 2 - visibleWidth(label) - (label ? 3 : 0));
			lines[0] = label ? color(`╰${"─".repeat(fill)}`) + label + color("───╯") : color(`╰${"─".repeat(width - 2)}╯`);
			return lines;
		};
	}
	if (!editor[WRAPPED].includes(bottom)) editor[WRAPPED].push(bottom);
}
