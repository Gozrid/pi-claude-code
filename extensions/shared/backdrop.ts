/**
 * Darkens everything behind an overlay, so the dialog stands out: the /usage
 * dialog (usage-graph) and the wish popup (pi-bridge).
 *
 * pi-tui has no backdrop for overlays, so this wraps the TUI's
 * compositeOverlays(): while a backdrop is open, the visible lines below the
 * overlays lose their colours and are drawn in one faint shade, then the
 * overlays are laid on top as usual.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor, foregroundAnsi, type TUI } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/** How far the theme's dim colour is pushed toward the background (0-1). */
const DARKEN = 0.55;

/** SGR sequences (colours, bold, …); other escapes such as hyperlinks stay. */
const SGR = /\x1b\[[0-9;:]*m/g;
/** Kitty and iTerm2 image lines cannot be recoloured; they are left as they are. */
const IMAGE = /\x1b_G|\x1b\]1337;File=/;

/** The line in one shade: its own colours and backgrounds removed. */
export function shadeLine(line: string, shadeAnsi: string): string {
	if (IMAGE.test(line)) return line;
	const plain = line.replace(SGR, "");
	return plain ? `${shadeAnsi}${plain}\x1b[0m` : plain;
}

/**
 * Opening escape of the backdrop shade: the theme's dim colour, pushed
 * `amount` (0-1) toward the background; DARKEN when fully faded in.
 */
export function shadeAnsi(theme: Theme, amount = DARKEN): string {
	try {
		const background = theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
		const mix = Math.max(0, Math.min(1, amount));
		return foregroundAnsi(mixColors(theme.colors.dim, background, mix, "srgb"), theme.getColorMode());
	} catch {
		return "\x1b[2m";
	}
}

interface Compositor {
	compositeOverlays(lines: string[], width: number, height: number): string[];
}

/**
 * An open backdrop: turns the lines below the overlays into what is shown.
 * Made by the code that opened it, so the wrapper itself never needs to change.
 */
interface Backdrop {
	apply(lines: string[], height: number): string[];
}

/** Open backdrops of one renderer; the last one opened decides. */
interface BackdropState {
	open: Backdrop[];
}

/**
 * Kept on the renderer under a global symbol, so the wrapper is installed once
 * and a reloaded extension finds it again. The version in the key changes
 * whenever the wrapper's contract changes, so a newer pi-claude-code puts its
 * own wrapper in place of one a reload left behind. The key keeps its old name
 * (from when only usage-graph had a backdrop): every extension shares the one
 * wrapper, whichever opened a backdrop first.
 */
const STATE = Symbol.for("pi-claude-code.usage-graph.backdrop.v2");

/** The lines with the visible part (the last `height`) in `shade`. */
function darkenLines(lines: string[], height: number, shade: string): string[] {
	const start = Math.max(0, lines.length - height);
	return lines.map((line, i) => (i < start ? line : shadeLine(line, shade)));
}

/**
 * Darkens the screen behind the overlays until the returned function is called,
 * fading in over `fadeMs` (the caller renders the frames meanwhile).
 *
 * pi hands extensions a proxy of its renderer that gives out a new function on
 * every read, so the wrapper is never compared or removed: it stays installed
 * and does nothing while no backdrop is open.
 */
export function darkenBackdrop(tui: TUI, theme: Theme, fadeMs = 0): () => void {
	const target = tui as unknown as Compositor & { [STATE]?: BackdropState };
	let state = target[STATE];
	if (!state) {
		// The renderer's own method, not what the proxy hands out (that may be an older wrapper).
		const original = (Object.getPrototypeOf(tui) as Partial<Compositor> | null)?.compositeOverlays;
		if (typeof original !== "function") return () => {};
		const installed: BackdropState = { open: [] };
		target.compositeOverlays = function (this: Compositor, lines, width, height) {
			const top = installed.open[installed.open.length - 1];
			let shown = lines;
			try {
				if (top && typeof top.apply === "function") shown = top.apply(lines, height);
			} catch {
				// A broken backdrop must never break pi's screen.
			}
			return original.call(this, shown, width, height);
		};
		target[STATE] = installed;
		state = installed;
	}
	const full = shadeAnsi(theme);
	const start = Date.now();
	const shade = () => {
		const t = fadeMs > 0 ? (Date.now() - start) / fadeMs : 1;
		return t >= 1 ? full : shadeAnsi(theme, DARKEN * (1 - (1 - t) ** 3));
	};
	const entry: Backdrop = { apply: (lines, height) => darkenLines(lines, height, shade()) };
	const open = state.open;
	open.push(entry);
	tui.requestRender();
	return () => {
		const i = open.indexOf(entry);
		if (i < 0) return;
		open.splice(i, 1);
		tui.requestRender();
	};
}
