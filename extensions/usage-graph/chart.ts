/**
 * Line chart in braille dots: each cell holds 2×4 dots, so a chart of
 * `width` × `height` cells draws 2·width × 4·height points.
 *
 *  100%┤
 *      │        ⢀⣀⣀⡠⠤⠒⠒⠉
 *   50%┤     ⣀⠔⠊
 *      │⣀⣀⡠⠊               ⣀⣀
 *    0%┤⠀       ⠀  ⠀⠀⠀⠀⣀⡠⠔⠊
 *      └──────────────────────
 *       -24h        -12h   now
 *
 * A usage value holds until the next sample (step line), and drops to 0 once
 * the window's reset time has passed.
 */

import { easeOut } from "../shared/opening.ts";

export interface Point {
	t: number;
	/** 0-100 */
	p: number;
	/** Reset time of the window, ms since the epoch. */
	r?: number;
}

export interface Series {
	/** Sorted by time. */
	points: readonly Point[];
	/** Colours one cell's text. */
	color: (text: string) => string;
}

/** The value at `t`: the last sample before it, 0 after its window reset, undefined before the first sample. */
export function valueAt(points: readonly Point[], t: number): number | undefined {
	let lo = 0;
	let hi = points.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].t <= t) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (found < 0) return undefined;
	const point = points[found];
	return point.r !== undefined && point.r <= t ? 0 : point.p;
}

/** Bit of the dot at (column 0-1, row 0-3) within a braille cell. */
const DOTS = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];

export { easeOut };

/**
 * How far part `index` of `count` is when the whole is at `progress` (0-1),
 * the parts one after another: the first runs from 0 to 1/count, and so on.
 */
export function sequential(progress: number, index: number, count: number): number {
	if (progress >= 1) return 1;
	return Math.max(0, Math.min(1, progress * Math.max(1, count) - index));
}

/**
 * The plot area only: `height` lines of `width` cells (no axes). With
 * `reveal` below 1 the lines are still being drawn, one after another, each
 * from the left.
 */
export function plot(
	series: readonly Series[],
	from: number,
	to: number,
	width: number,
	height: number,
	now = to,
	reveal = 1,
): string[] {
	const cols = width * 2;
	const rows = height * 4;
	const bits = new Uint8Array(width * height);
	const colors: (Series["color"] | undefined)[] = new Array(width * height);
	const yOf = (p: number) => Math.round((1 - Math.max(0, Math.min(100, p)) / 100) * (rows - 1));
	const set = (x: number, y: number, color: Series["color"]) => {
		const cell = Math.floor(y / 4) * width + Math.floor(x / 2);
		bits[cell] |= DOTS[x % 2][y % 4];
		colors[cell] = color;
	};

	series.forEach((s, i) => {
		let prev: number | undefined;
		const shown = Math.round(sequential(reveal, i, series.length) * cols);
		for (let x = 0; x < shown; x++) {
			const t = from + ((x + 0.5) / cols) * (to - from);
			const v = t > now ? undefined : valueAt(s.points, t);
			if (v === undefined) {
				prev = undefined;
				continue;
			}
			const y = yOf(v);
			const [a, b] = prev === undefined ? [y, y] : [Math.min(prev, y), Math.max(prev, y)];
			for (let yy = a; yy <= b; yy++) set(x, yy, s.color);
			prev = y;
		}
	});

	const lines: string[] = [];
	for (let r = 0; r < height; r++) {
		let line = "";
		for (let c = 0; c < width; c++) {
			const cell = r * width + c;
			line += bits[cell] ? (colors[cell] ?? String)(String.fromCharCode(0x2800 + bits[cell])) : " ";
		}
		lines.push(line);
	}
	return lines;
}

/** "45m", "5h", "7d": how long before now. */
export function formatAgo(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export const AXIS_WIDTH = 6;

/** Labels of the value axis at the top, the middle and the bottom; values are plotted as 0-100. */
export interface AxisLabels {
	top: string;
	mid: string;
	bottom: string;
}

const PERCENT_AXIS: AxisLabels = { top: "100%", mid: "50%", bottom: "0%" };

/**
 * The chart with a value axis on the left (percent unless `labels` say
 * otherwise) and a time axis below. `dim` colours the axes.
 */
export function chart(
	series: readonly Series[],
	opts: {
		from: number;
		to: number;
		width: number;
		height: number;
		dim: (text: string) => string;
		now?: number;
		labels?: AxisLabels;
		/** Draws the area between the axes instead of the line plot of `series`. */
		body?: (width: number, height: number) => string[];
		/** How far the lines are drawn (0-1), one after another, for the build-up animation. */
		reveal?: number;
	},
): string[] {
	const { from, to, height, dim } = opts;
	const labels = opts.labels ?? PERCENT_AXIS;
	const axisWidth = Math.max(AXIS_WIDTH, 2 + Math.max(labels.top.length, labels.mid.length, labels.bottom.length));
	const width = Math.max(4, opts.width - axisWidth);
	const body = opts.body ? opts.body(width, height) : plot(series, from, to, width, height, opts.now ?? to, opts.reveal ?? 1);
	const label = (row: number) => {
		if (row === 0) return `${labels.top}┤`;
		if (row === height - 1) return `${labels.bottom}┤`;
		if (height >= 5 && row === Math.floor((height - 1) / 2)) return `${labels.mid}┤`;
		return "│";
	};
	const lines = body.map((line, row) => dim(label(row).padStart(axisWidth)) + line);
	lines.push(dim(`${" ".repeat(axisWidth - 1)}└${"─".repeat(width)}`));

	// Time labels at the left end, the middle and "now" at the right.
	const left = `-${formatAgo(to - from)}`;
	const mid = `-${formatAgo((to - from) / 2)}`;
	const right = "now";
	const axis = new Array(width).fill(" ");
	const put = (text: string, at: number) => {
		const start = Math.max(0, Math.min(width - text.length, at));
		for (let i = 0; i < text.length; i++) axis[start + i] = text[i];
	};
	put(left, 0);
	if (width >= left.length + mid.length + right.length + 6) put(mid, Math.round(width / 2 - mid.length / 2));
	put(right, width - right.length);
	lines.push(dim(" ".repeat(axisWidth) + axis.join("")));
	return lines;
}

/** Partial blocks for 1/8 to 7/8 of a cell's height. */
const EIGHTHS = "▁▂▃▄▅▆▇";

/**
 * Stacked bars: one bar per entry of `values` (left to right, oldest first),
 * each stacked from the bottom with a segment per series (`values[bar][i]`,
 * coloured with `colors[i]`). `max` is the height of the full area. Each bar
 * stands at its place in time across `width`, all equally wide with a gap
 * after each when there is room; more bars than columns are merged. With
 * `progress` below 1 the bars are still growing, one after another from the left.
 */
export function stackedBars(
	values: readonly (readonly number[])[],
	colors: readonly ((text: string) => string)[],
	max: number,
	width: number,
	height: number,
	progress = 1,
): string[] {
	let bars = values.map((v) => [...v]);
	if (bars.length > width) {
		const group = Math.ceil(bars.length / width);
		const merged: number[][] = [];
		for (let i = 0; i < bars.length; i += group) {
			merged.push(bars.slice(i, i + group).reduce((sum, bar) => sum.map((x, k) => x + (bar[k] ?? 0)), new Array(colors.length).fill(0)));
		}
		bars = merged;
	}
	const units = height * 8;
	const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(" "));
	const n = bars.length;
	// Each bar at its place in time, all equally wide; only the gaps differ by a column.
	const slot = Math.max(1, Math.floor(width / Math.max(1, n)));
	const columns = slot > 1 ? slot - 1 : 1;
	bars.forEach((bar, b) => {
		const start = Math.min(width - columns, Math.floor((b * width) / n));
		// Segment tops in eighths of a cell, cumulative from the bottom.
		const tops: number[] = [];
		const grown = easeOut(sequential(progress, b, n));
		let sum = 0;
		for (const v of bar) {
			sum += Math.max(0, v) * grown;
			tops.push(max > 0 ? Math.min(units, Math.round((sum / max) * units)) : 0);
		}
		let total = tops[tops.length - 1] ?? 0;
		if (total === 0 && sum > 0) total = 1;
		for (let row = 0; row < height; row++) {
			const lo = row * 8;
			const filled = Math.max(0, Math.min(8, total - lo));
			if (filled === 0) break;
			// The series that covers most of the filled part of this cell.
			let best = -1;
			let bestOverlap = 0;
			tops.forEach((top, i) => {
				const bottom = i === 0 ? 0 : tops[i - 1];
				const overlap = Math.min(top, lo + filled) - Math.max(bottom, lo);
				if (overlap > bestOverlap) {
					bestOverlap = overlap;
					best = i;
				}
			});
			if (best < 0) best = bar.findIndex((v) => v > 0);
			const char = filled === 8 ? "█" : EIGHTHS[filled - 1];
			const cell = (colors[best] ?? String)(char);
			for (let c = start; c < start + columns; c++) grid[height - 1 - row][c] = cell;
		}
	});
	return grid.map((row) => row.join(""));
}
