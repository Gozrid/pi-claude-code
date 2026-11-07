/**
 * Effort picker: the model's levels on a horizontal timeline.
 *
 *   ●━━━━━━━━━━━━●━━━━━━━━━━━━◉────────────○────────────○
 *  low        medium        high        xhigh         max
 *
 * ←/→ (or h/l) move, 1-n jump to a level, home/end to the ends, enter confirms,
 * esc cancels. The mouse (pi's fullscreen mode): a click on a level or its name
 * picks it, a second click on it (or a double click) confirms; the wheel moves.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/** Widest gap between two levels on the track. */
const MAX_STEP = 14;
const INDENT = "  ";

/** Row of the track in the picker; the names are on the row below. */
const TRACK_ROW = 3;

/** The columns of the levels on the track, from the left edge of the picker. */
function levelColumns(width: number, levels: string[]): number[] {
	const n = levels.length;
	const labelWidth = Math.max(...levels.map((level) => level.length));
	const margin = Math.ceil(labelWidth / 2);
	const room = width - INDENT.length * 2 - margin * 2;
	const span = n > 1 ? Math.max(2 * (n - 1), Math.min(MAX_STEP * (n - 1), room)) : 0;
	return levels.map((_, i) => INDENT.length + margin + (n > 1 ? Math.round((i * span) / (n - 1)) : 0));
}

function renderTimeline(theme: Pick<Theme, "fg" | "bold">, width: number, levels: string[], selected: number): string[] {
	const margin = Math.ceil(Math.max(...levels.map((level) => level.length)) / 2);
	const positions = levelColumns(width, levels).map((column) => column - INDENT.length - margin);
	const span = positions[positions.length - 1];

	let track = "";
	for (let x = 0; x <= span; x++) {
		const node = positions.indexOf(x);
		if (node === selected) track += theme.bold(theme.fg("accent", "◉"));
		else if (node >= 0) track += node < selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
		else track += x < positions[selected] ? theme.fg("accent", "━") : theme.fg("dim", "─");
	}

	let labels = "";
	let column = 0;
	levels.forEach((level, i) => {
		const start = margin + positions[i] - Math.floor(level.length / 2);
		const gap = Math.max(i === 0 ? 0 : 1, start - column);
		labels += " ".repeat(gap) + (i === selected ? theme.bold(theme.fg("accent", level)) : theme.fg("muted", level));
		column += gap + level.length;
	});

	return [`${INDENT}${" ".repeat(margin)}${track}`, `${INDENT}${labels}`];
}

/**
 * The picker as a component: `done` gets the chosen level, or undefined when
 * cancelled. `hints` describe the levels; `current` is preselected and marked.
 */
export function effortPicker(
	theme: Pick<Theme, "fg" | "bold">,
	title: string,
	levels: string[],
	current: string,
	hints: Record<string, string>,
	requestRender: () => void,
	done: (level: string | undefined) => void,
): Component {
		let selected = Math.max(0, levels.indexOf(current));
		let lastWidth = 0;
		const select = (index: number) => {
			selected = Math.min(levels.length - 1, Math.max(0, index));
			requestRender();
		};

		return {
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "wheel" && event.wheelDelta) {
					select(selected + (event.wheelDelta < 0 ? -1 : 1));
					return { handled: true };
				}
				if (event.type !== "press" && event.type !== "release" && event.type !== "click") return undefined;
				if (event.type !== "click" || event.button !== "left" || (event.y !== TRACK_ROW && event.y !== TRACK_ROW + 1)) {
					return { handled: true, render: false };
				}
				const columns = levelColumns(lastWidth || event.width, levels);
				let nearest = 0;
				columns.forEach((column, i) => {
					if (Math.abs(column - event.x) < Math.abs(columns[nearest] - event.x)) nearest = i;
				});
				if (nearest === selected || (event.clickCount ?? 1) >= 2) {
					selected = nearest;
					done(levels[selected]);
				} else select(nearest);
				return { handled: true };
			},
			render(width: number): string[] {
				lastWidth = width;
				const level = levels[selected];
				const hint = [hints[level], level === current ? "current" : undefined].filter(Boolean).join(" · ");
				const lines = [
					theme.fg("accent", "─".repeat(width)),
					`${INDENT}${theme.bold(title)}`,
					"",
					...renderTimeline(theme, width, levels, selected),
					"",
					`${INDENT}${theme.bold(theme.fg("accent", level))}${hint ? theme.fg("muted", ` · ${hint}`) : ""}`,
					`${INDENT}${theme.fg("dim", "←/→ or click adjust · enter confirm · esc cancel")}`,
					theme.fg("accent", "─".repeat(width)),
				];
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.left) || data === "h") select(selected - 1);
				else if (matchesKey(data, Key.right) || data === "l") select(selected + 1);
				else if (matchesKey(data, Key.home)) select(0);
				else if (matchesKey(data, Key.end)) select(levels.length - 1);
				else if (/^[1-9]$/.test(data) && Number(data) <= levels.length) select(Number(data) - 1);
				else if (matchesKey(data, Key.enter)) done(levels[selected]);
				else if (matchesKey(data, Key.escape)) done(undefined);
			},
		};
}

/** Shows the picker and resolves to the chosen level, or undefined when cancelled. */
export function pickEffort(
	ctx: ExtensionContext,
	title: string,
	levels: string[],
	current: string,
	hints: Record<string, string>,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
		effortPicker(theme, title, levels, current, hints, () => tui.requestRender(), done),
	);
}
