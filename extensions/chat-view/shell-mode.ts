/**
 * Shell mode (part of chat-view)
 *
 * A prompt starting with ! runs as a shell command (pi's own feature): with one
 * ! its output goes to the model with the next message, with !! it stays with
 * you. The editor shows which one it is:
 *
 *   ────────────────────────────────────────────   ← purple, swept in from the left
 *   !git status          ! shell · output goes to the AI
 *   ────────────────────────────────────────────
 *
 * - !  the editor's borders turn purple: a bright wave runs along them from the
 *      left, purple behind it; leaving the mode sweeps the old colour back in
 * - !! the same, and the text turns grey: the output stays out of the model's sight
 * - both: a short grey hint at the right end of the last text row (on the bottom
 *   border when the row is too full)
 *
 * pi has no hook for the editor's look, so the editor instance's render and its
 * borderColor are wrapped (a replaced editor is wrapped on the next frame).
 * PI_SHELL_MODE_VIEW=0 turns it off, PI_HISTORY_STATIC=1 the animation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Color, foregroundAnsi, mixColors, rgbColor, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findEditor } from "./editor-frame.ts";

type Theme = ExtensionContext["ui"]["theme"];

const WIDGET = "shell-mode";
const OFF = process.env.PI_SHELL_MODE_VIEW === "0";
const STATIC = process.env.PI_HISTORY_STATIC === "1";
const WRAPPED = Symbol.for("pi-claude-code.chat-view.shellMode");

/** How long the sweep along the border takes. */
export const SWEEP_MS = 450;
const FRAME_MS = 16;
/** Cells of the bright head of the wave, fading into purple behind it. */
const TAIL = 10;

export type ShellMode = "context" | "private";

/** The shell mode of the editor text: ! (output to the model), !! (output stays), or none. */
export function shellMode(text: string): ShellMode | undefined {
	const start = text.trimStart();
	if (start.startsWith("!!")) return "private";
	if (start.startsWith("!")) return "context";
	return undefined;
}

export const HINTS: Record<ShellMode, string> = {
	context: "! shell · output goes to the AI",
	private: "!! shell · output stays with you",
};

/** Purple and the bright head of the wave, for dark and light themes. */
export function palette(appearance: string): { purple: Color; head: Color } {
	return appearance === "light"
		? { purple: rgbColor(128, 64, 208), head: rgbColor(214, 160, 255) }
		: { purple: rgbColor(178, 122, 255), head: rgbColor(244, 228, 255) };
}

const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Where cell `i` of `n` stands in the sweep at `progress` (0…1): "new" behind the
 * wave, "old" ahead of it, or a number between (0 the brightest head, 1 its end).
 * The wave runs left to right; `reverse` runs it right to left.
 */
export function sweepAt(i: number, n: number, progress: number, reverse = false): "old" | "new" | number {
	if (progress >= 1) return "new";
	const cell = reverse ? n - 1 - i : i;
	const head = ease(Math.max(0, progress)) * (n + TAIL);
	const behind = head - cell;
	if (behind <= 0) return "old";
	if (behind >= TAIL) return "new";
	return behind / TAIL;
}

/** The trailing plain spaces of a row, which the hint may take. */
function trailingSpaces(row: string): number {
	return row.length - row.replace(/ +$/, "").length;
}

/**
 * Puts the hint at the right end of `row` if its trailing spaces leave room (two
 * cells before it); undefined when it does not fit.
 */
export function withHint(row: string, hint: string, width: number): string | undefined {
	const free = trailingSpaces(row);
	const needed = visibleWidth(hint) + 3;
	if (free < needed || visibleWidth(row) > width) return undefined;
	return `${row.slice(0, row.length - visibleWidth(hint) - 1)}${hint} `;
}

/** Greys `row`, re-applying the grey after every colour reset inside it. */
export function greyed(row: string, grey: string): string {
	const again = row.replace(/\x1b\[(0|39)?m/g, (reset) => `${reset}${grey}`);
	return `${grey}${again}\x1b[39m`;
}

interface ShellEditor {
	render(width: number): string[];
	getText(): string;
	borderColor?: (text: string) => string;
	renderedVisibleLineCount?: number;
	renderedAutocompleteHeight?: number;
	[WRAPPED]?: { theme: Theme; tui: TUI };
}

export function wrap(editor: ShellEditor, tui: TUI, theme: Theme): void {
	const state = { theme, tui };
	editor[WRAPPED] = state;
	const original = editor.render.bind(editor);

	// pi sets borderColor (thinking level, its own green for !); the wrapper keeps
	// what pi set and hands out the purple while the mode is on or sweeping.
	let set = editor.borderColor;
	/** The colour before the mode came on, which the sweep starts from and returns to. */
	let normal = set;
	let mode: ShellMode | undefined;
	let changed = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const progress = () => (STATIC ? 1 : Math.min(1, (Date.now() - changed) / SWEEP_MS));
	const plainColor = (text: string) => text;

	const animated = (text: string): string => {
		const { theme: t } = state;
		const colorMode = t.getColorMode();
		const { purple, head } = palette(t.appearance);
		const purpleAnsi = foregroundAnsi(purple, colorMode);
		const old = normal ?? plainColor;
		const p = progress();
		const entering = mode !== undefined;
		if (p >= 1) return entering ? `${purpleAnsi}${text}\x1b[39m` : old(text);
		const cells = Array.from(text);
		return cells
			.map((cell, i) => {
				const at = sweepAt(i, cells.length, p, !entering);
				if (at === "new") return entering ? `${purpleAnsi}${cell}\x1b[39m` : old(cell);
				if (at === "old") return entering ? old(cell) : `${purpleAnsi}${cell}\x1b[39m`;
				return `${foregroundAnsi(mixColors(head, purple, at, "oklch"), colorMode)}${cell}\x1b[39m`;
			})
			.join("");
	};

	Object.defineProperty(editor, "borderColor", {
		configurable: true,
		get: () => (mode !== undefined || progress() < 1 ? animated : set),
		set: (value: ((text: string) => string) | undefined) => {
			set = value;
			// pi sets its own colour for ! as the text changes, before the next render.
			if (shellMode(editor.getText()) === undefined) normal = value;
		},
	});

	editor.render = (width: number) => {
		const now = shellMode(editor.getText());
		if (now === undefined) normal = set;
		if ((now === undefined) !== (mode === undefined)) {
			changed = Date.now();
			if (!STATIC && !timer) {
				timer = setInterval(() => {
					state.tui.requestRender();
					if (progress() < 1) return;
					clearInterval(timer);
					timer = undefined;
				}, FRAME_MS);
				timer.unref?.();
			}
		}
		mode = now;

		const lines = original(width);
		if (!mode) return lines;
		const suggestions = editor.renderedAutocompleteHeight ?? 0;
		const count = editor.renderedVisibleLineCount ?? lines.length - 2 - suggestions;
		if (count < 1 || lines.length < count + 2) return lines;

		const { theme: t } = state;
		const hint = t.fg("dim", HINTS[mode]);
		const last = count;
		const placed = withHint(lines[last]!, hint, width);
		if (placed) lines[last] = placed;
		else {
			// No room in the text: on the bottom border, at its right end.
			const border = editor.borderColor ?? plainColor;
			const label = ` ${hint} `;
			const fill = Math.max(0, width - visibleWidth(label) - 2);
			lines[last + 1] = truncateToWidth(`${border("─".repeat(fill))}${label}${border("──")}`, width);
		}
		if (mode === "private") {
			const grey = t.getFgAnsi("dim");
			for (let i = 1; i <= count; i++) lines[i] = greyed(lines[i]!, grey);
		}
		return lines;
	};
}

export function shellModeView(pi: ExtensionAPI) {
	if (OFF) return;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// A widget that draws nothing; it finds the editor before it renders, each frame.
		ctx.ui.setWidget(WIDGET, (tui, theme) => ({
			render: () => {
				const editor = findEditor(tui) as ShellEditor | undefined;
				if (editor && typeof editor.getText === "function") {
					const state = editor[WRAPPED];
					if (!state) wrap(editor, tui, theme);
					else Object.assign(state, { tui, theme });
				}
				return [];
			},
			invalidate() {},
		}));
	});
}
