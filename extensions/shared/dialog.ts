/**
 * The frame of the popup dialogs (subagents, wishes, workflow, /usage) and how
 * the mouse closes them (pi's fullscreen mode):
 *
 *   ╭─ Wishes ───────────────────────── ✕ ─╮
 *   │ …                                    │
 *   ╰─ esc close ──────────────────────────╯
 *
 * - a click on the ✕ in the top border closes the dialog,
 * - a click outside it, on the darkened chat, closes it too; every other mouse
 *   event outside it is swallowed, so the chat behind it neither scrolls nor
 *   selects text while the dialog is open.
 *
 * pi-tui hands mouse events outside an overlay to the chat, so a dialog never
 * sees them. closable() wraps the renderer's dispatchMouseToOverlay() (like
 * backdrop.ts wraps compositeOverlays()) and takes the events outside the
 * dialog opened last.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

/** The close button at the right end of a frame's top border: "✕ ─╮". */
export const CLOSE_BUTTON = "✕";

/** Narrower frames (still unfolding) have no room for the close button. */
const CLOSE_MIN_WIDTH = 10;

/**
 * Whether a mouse event is a left click on the close button: the top row, on
 * the ✕ or the cell next to it, of a frame `width` wide.
 */
export function closeClicked(event: { type: string; button?: string; x: number; y: number }, width: number): boolean {
	return event.type === "click" && onCloseButton(event, width);
}

/** Whether a left-button event is on the close button (press, release or click). */
function onCloseButton(event: { button?: string; x: number; y: number }, width: number): boolean {
	return event.button === "left" && event.y === 0 && width >= CLOSE_MIN_WIDTH && event.x >= width - 5 && event.x <= width - 3;
}

/**
 * A rounded frame around `lines` (each `width - 4` wide), with `title` and the
 * close button in the top border and `hint` in the bottom one.
 */
export function dialogFrame(theme: Theme, width: number, title: string, hint: string, lines: string[]): string[] {
	const border = (text: string) => theme.fg("borderAccent", text);
	const room = width - 2;
	const top = () => {
		if (width < CLOSE_MIN_WIDTH) return edge("╭", title, "╮");
		const close = `${theme.fg("dim", CLOSE_BUTTON)}${border(" ─╮")}`;
		// "╭─ " title " " filler " " ✕ " ─╮"
		const text = truncateToWidth(title, Math.max(0, width - 10), "…");
		if (!text) return `${border(`╭${"─".repeat(width - 6)} `)}${close}`;
		const filler = Math.max(0, width - 9 - visibleWidth(text));
		return `${border("╭─ ")}${text}${border(` ${"─".repeat(filler)} `)}${close}`;
	};
	const edge = (left: string, label: string, right: string) => {
		const text = truncateToWidth(label, Math.max(0, room - 4), "…");
		const filler = Math.max(0, room - 3 - visibleWidth(text));
		return text ? `${border(`${left}─ `)}${text}${border(` ${"─".repeat(filler)}${right}`)}` : border(`${left}${"─".repeat(room)}${right}`);
	};
	return [top(), ...lines.map((line) => `${border("│")} ${line} ${border("│")}`), edge("╰", hint, "╯")];
}

/** An open dialog: its component (as pi shows it) and how it closes. */
interface OpenDialog {
	component: unknown;
	close(): void;
}

/** What the wrapper needs of pi-tui's renderer (TuiAltScreen). */
interface OverlayLayout {
	row: number;
	col: number;
	width: number;
	height: number;
	entry?: { component?: unknown };
}
type DispatchResult = { hit: boolean; result?: unknown };
interface MouseRouter {
	dispatchMouseToOverlay(event: TuiMouseEvent): DispatchResult;
	renderedOverlayLayouts?: OverlayLayout[];
}

/** Open dialogs of one renderer; the last one opened takes the clicks outside. */
interface DialogState {
	open: OpenDialog[];
}

/**
 * Kept on the renderer under a global symbol, so the wrapper is installed once
 * and a reloaded extension finds it again; the version in the key changes with
 * the wrapper's contract.
 */
const STATE = Symbol.for("pi-claude-code.dialog.outside-click.v1");

/** The index in `layouts` of the topmost overlay under the pointer, or -1. */
function layoutAt(layouts: OverlayLayout[], x: number, y: number): number {
	for (let i = layouts.length - 1; i >= 0; i--) {
		const l = layouts[i];
		if (x >= l.col && x < l.col + l.width && y >= l.row && y < l.row + l.height) return i;
	}
	return -1;
}

/**
 * Takes a mouse event outside the dialog: a left click closes it, everything
 * else is only swallowed. Returned as a dispatch result whose target catches
 * the release and click that follow a press.
 */
function outside(event: TuiMouseEvent, dialog: OpenDialog): DispatchResult {
	const catcher: Component = {
		render: () => [],
		invalidate() {},
		handleMouse(e: TuiMouseEvent): TuiMouseEventResult {
			if (e.type === "click" && e.button === "left") dialog.close();
			return { handled: true, render: false };
		},
	};
	if (event.type === "click" && event.button === "left") dialog.close();
	const target = { component: catcher, originX: 0, originY: 0, width: event.width, height: event.height };
	return { hit: true, result: { handled: true, render: false, target } };
}

/** The renderer's dispatchMouseToOverlay, wrapped once; undefined when pi-tui has none. */
function dialogState(tui: TUI): DialogState | undefined {
	const target = tui as unknown as MouseRouter & { [STATE]?: DialogState };
	const existing = target[STATE];
	if (existing) return existing;
	// The renderer's own method, not what pi's proxy hands out.
	const original = (Object.getPrototypeOf(tui) as Partial<MouseRouter> | null)?.dispatchMouseToOverlay;
	if (typeof original !== "function") return undefined;
	const state: DialogState = { open: [] };
	target.dispatchMouseToOverlay = function (this: MouseRouter, event) {
		const dialog = state.open[state.open.length - 1];
		if (!dialog) return original.call(this, event);
		try {
			const layouts = this.renderedOverlayLayouts;
			if (!Array.isArray(layouts)) {
				const result = original.call(this, event);
				return result.hit ? result : outside(event, dialog);
			}
			const mine = layouts.findIndex((l) => l.entry?.component === dialog.component);
			// Not drawn (hidden), or something opened above it: pi decides as usual.
			if (mine < 0) return original.call(this, event);
			const under = layoutAt(layouts, event.screenX, event.screenY);
			if (under >= mine) return original.call(this, event);
			return outside(event, dialog);
		} catch {
			// A broken wrapper must never break pi's mouse.
			return original.call(this, event);
		}
	};
	target[STATE] = state;
	return state;
}

/**
 * Makes a popup dialog closable with the mouse: a click on the ✕ of its frame
 * (dialogFrame) or outside it calls `close`, as esc does. Returns the component
 * to hand to pi; the click outside stops when it closes or is disposed.
 */
export function closable<T extends Component & { dispose?(): void }>(tui: TUI, dialog: T, close: () => void): T {
	const state = dialogState(tui);
	let entry: OpenDialog | undefined;
	const forget = () => {
		if (!state || !entry) return;
		const i = state.open.indexOf(entry);
		if (i >= 0) state.open.splice(i, 1);
		entry = undefined;
	};
	const shut = () => {
		forget();
		close();
	};
	const handleMouse = dialog.handleMouse?.bind(dialog);
	dialog.handleMouse = (event: TuiMouseEvent) => {
		if (onCloseButton(event, event.width)) {
			if (event.type === "click") shut();
			return { handled: true, render: false };
		}
		return handleMouse?.(event);
	};
	const dispose = dialog.dispose?.bind(dialog);
	dialog.dispose = () => {
		forget();
		dispose?.();
	};
	if (state) {
		entry = { component: dialog, close: shut };
		state.open.push(entry);
	}
	return dialog;
}
