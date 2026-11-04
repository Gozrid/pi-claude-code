/**
 * Prompt history (part of chat-view)
 *
 * ↑ in the empty editor opens a list of the user's prompts of this session right
 * above the editor, growing upwards row by row. ↑/↓ walk it and put the selected
 * prompt into the editor; enter sends it, esc empties the editor, ↓ past the
 * newest leaves the list, and any other key edits the prompt. Each of them closes
 * the list, which shrinks back. Its frame closes into the editor's top border.
 *
 * Keys are caught before the editor sees them, and only while it has focus, so
 * dialogs keep their arrow keys. The list takes the place of pi's own ↑ history.
 *
 * PI_HISTORY_STATIC=1 opens and closes the list without animation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { borderColor, editorHasFocus, frameRow, frameTop, joinEditor } from "./editor-frame.ts";
import { animatedRows, HistoryBrowser, userPrompts } from "./history.ts";

const WIDGET = "prompt-history";
const MS_PER_ROW = 20;
const STATIC = process.env.PI_HISTORY_STATIC === "1";

/** What the answer box needs to know about the list: it gives way while the list shows. */
export interface PromptHistoryState {
	showing(): boolean;
}

export function promptHistory(pi: ExtensionAPI): PromptHistoryState {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let browser: HistoryBrowser | undefined;
	let open = false;
	/** The animation runs from this height, starting at `since`. */
	let from = 0;
	let since = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopInput: (() => void) | undefined;

	const target = () => (open && browser ? browser.height : 0);
	const rows = () => (STATIC ? target() : animatedRows(from, target(), Date.now() - since, MS_PER_ROW));
	const showing = () => !!browser && rows() > 0;
	const bottom = () => (showing() ? {} : undefined);

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	/** Opens or closes the list; it grows or shrinks from the height it has right now. */
	const setOpen = (value: boolean) => {
		const height = rows();
		open = value;
		from = height;
		since = Date.now();
		stopTimer();
		tui?.requestRender();
		if (STATIC) return;
		timer = setInterval(() => {
			tui?.requestRender();
			if (rows() !== target()) return;
			stopTimer();
			if (!open) browser = undefined;
		}, MS_PER_ROW);
		timer.unref?.();
	};

	const editorFocused = () => editorHasFocus(tui);

	const setText = (text: string) => ctx?.ui.setEditorText(text);

	const onInput = (data: string) => {
		if (isKeyRelease(data) || !ctx) return undefined;
		if (!open) {
			if (!matchesKey(data, "up") || !editorFocused() || ctx.ui.getEditorText() !== "") return undefined;
			const prompts = userPrompts(ctx.sessionManager.getBranch());
			if (prompts.length === 0) return undefined;
			browser = new HistoryBrowser(prompts);
			install(ctx);
			setOpen(true);
			setText(browser.current);
			return { consume: true };
		}
		if (!browser || !editorFocused()) {
			setOpen(false);
			return undefined;
		}
		const step = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
		if (step !== 0) {
			if (browser.move(step)) {
				setText(browser.current);
				tui?.requestRender();
			} else if (step > 0) {
				setOpen(false);
				setText("");
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			setOpen(false);
			setText("");
			return { consume: true };
		}
		// Enter sends the prompt, anything else edits it; either way the list is done.
		setOpen(false);
		return undefined;
	};

	const reset = () => {
		stopTimer();
		open = false;
		browser = undefined;
		from = 0;
	};

	/**
	 * Sets the widget, or sets it again: pi stacks widgets in the order they were last
	 * set, and the frame has to be the last one to close into the editor's border.
	 */
	const install = (context: ExtensionContext) => {
		context.ui.setWidget(WIDGET, (ui, theme) => {
			tui = ui;
			return {
				render: (width: number) => {
					joinEditor(ui, bottom);
					const lines = browser ? browser.lines(theme, width - 4, rows()) : [];
					if (lines.length === 0) return [];
					const color = borderColor(ui);
					return [frameTop(color, width, theme.fg("muted", "History")), ...lines.map((line) => frameRow(color, width, line))];
				},
				invalidate() {},
				dispose() {
					stopTimer();
				},
			};
		});
	};

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		reset();
		if (context.mode !== "tui") return;
		stopInput?.();
		stopInput = context.ui.onTerminalInput(onInput);
		install(context);
	});

	pi.on("session_shutdown", async () => {
		reset();
		stopInput?.();
		stopInput = undefined;
		ctx = undefined;
		tui = undefined;
	});

	return { showing };
}
