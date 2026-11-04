/**
 * Provider logo for pi
 *
 * While the chat is empty, replaces pi's header with the logo of the selected
 * model's provider (Claude, Gemini, Mistral, …), centred in the chat area. The
 * built-in header comes back with the first message. Switching the model while
 * the chat is empty switches the logo. Animated logos (Clawd for Claude Code,
 * Gravi for Antigravity) play while they are shown; PI_LOGO_STATIC=1 keeps them still. The logo stays
 * centred in the terminal and only moves up, or gets smaller, when what is below
 * it (editor, footer) would otherwise push it off the top. It takes chat-view's
 * extension list over and draws it at the bottom left, and pi-bridge's open
 * wishes at the bottom right, beside the logo where they fit.
 *
 * Usage:
 *   /logo        show the logo again (until the next message)
 *   /costume     dress Clawd and Gravi up: a costume name, "none" or "auto" (by the date)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { EXTENSION_LIST_CHANNEL, type ExtensionListOffer } from "../chat-view/extension-list.ts";
import { rowClick, WISH_LIST_CHANNEL, type WishListOffer } from "../shared/wish-list.ts";
import { COSTUMES, chooseCostume, costumeFor, costumeName } from "./clawd.ts";
import { type Logo, logoFor, type Rgb } from "./logos.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Model = NonNullable<ExtensionContext["model"]>;

/** Rows below the header (editor, footer, …) when they can't be measured. */
const FALLBACK_BELOW = 8;

/** How often an animation checks for a new frame. */
const TICK_MS = 50;

const STATIC = !!process.env.PI_LOGO_STATIC;

function rgb(c: Rgb) {
	return { kind: "rgb" as const, ...c };
}

type Cell = { top?: Rgb; bottom?: Rgb };

const sameColor = (a?: Rgb, b?: Rgb) => a === b || (!!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b);

/**
 * Draws pixel art with half blocks, so pixels can be a non-whole number of rows high.
 * A pixel is `2 × scale` cells wide and `2 × scale` half rows high, so it stays roughly
 * square; `scale` is a multiple of 0.5. `room` half rows stay free above the art for
 * jumps, of which `lift` are currently used. Runs of equal cells share one styled span.
 */
function drawArt(theme: Theme, logo: Logo, art: string[], scale: number, lift = 0, room = 0): string[] {
	const size = Math.round(2 * scale);
	const width = Math.max(...art.map((row) => row.length));
	const blank = Array<Rgb | undefined>(width).fill(undefined);
	const noGlyphs = Array<string | undefined>(width).fill(undefined);
	const halves: (Rgb | undefined)[][] = Array.from({ length: room - lift }, () => blank);
	/** Per half row: the glyph pixels (see Logo.glyphs) and their colours, kept out of the blocks. */
	const glyphs: (string | undefined)[][] = Array.from({ length: room - lift }, () => noGlyphs);
	const glyphColors: (Rgb | undefined)[][] = Array.from({ length: room - lift }, () => blank);
	art.forEach((row, r) => {
		const chars = [...row.padEnd(width, ".")];
		const colors = chars.map((char, c) =>
			char === "." ? undefined : typeof logo.color === "function" ? logo.color(r, c, char) : logo.color[char],
		);
		const rowGlyphs = chars.map((char) => logo.glyphs?.[char]);
		const blocks = colors.map((color, c) => (rowGlyphs[c] ? undefined : color));
		const small = colors.map((color, c) => (rowGlyphs[c] ? color : undefined));
		for (let i = 0; i < size; i++) {
			halves.push(blocks);
			// A glyph takes one cell, so it is set once, in the pixel's first half row.
			glyphs.push(i === 0 ? rowGlyphs : noGlyphs);
			glyphColors.push(small);
		}
	});
	for (let i = 0; i < lift; i++) {
		halves.push(blank);
		glyphs.push(noGlyphs);
		glyphColors.push(blank);
	}
	if (halves.length % 2) {
		halves.push(blank);
		glyphs.push(noGlyphs);
		glyphColors.push(blank);
	}

	const glyph = ({ top, bottom }: Cell, text: number): string => {
		const cells = text > 0 ? " ".repeat(text) : "";
		if (!top && !bottom) return cells;
		if (sameColor(top, bottom)) return theme.style("█".repeat(text), { fg: rgb(top!) });
		if (!bottom) return theme.style("▀".repeat(text), { fg: rgb(top!) });
		if (!top) return theme.style("▄".repeat(text), { fg: rgb(bottom) });
		return theme.style("▀".repeat(text), { fg: rgb(top), bg: rgb(bottom) });
	};
	const lines: string[] = [];
	for (let r = 0; r < halves.length; r += 2) {
		let line = "";
		let run: Cell | undefined;
		let count = 0;
		for (let c = 0; c < width; c++) {
			const cell = { top: halves[r][c], bottom: halves[r + 1][c] };
			const small = glyphs[r][c] ?? glyphs[r + 1][c];
			if (small && !cell.top && !cell.bottom) {
				if (run) line += glyph(run, count);
				run = undefined;
				count = 0;
				const color = glyphColors[r][c] ?? glyphColors[r + 1][c];
				line += theme.style(small, { fg: rgb(color!) }) + " ".repeat(size - 1);
				continue;
			}
			if (run && sameColor(run.top, cell.top) && sameColor(run.bottom, cell.bottom)) count += size;
			else {
				if (run) line += glyph(run, count);
				run = cell;
				count = size;
			}
		}
		if (run) line += glyph(run, count);
		// Rows keep their trailing blanks: equal widths centre the art as one block.
		lines.push(line);
	}
	return lines;
}

/**
 * The largest pixel scale (1-3, in steps of 0.5, at most the logo's own limit) at which
 * the art uses at most about half of the space (60% of the width).
 */
function scaleFor(logo: Logo, width: number, height: number): number {
	const cols = Math.max(...logo.art.map((row) => row.length)) * 2;
	const rows = logo.art.length + (logo.lift ?? 0);
	for (let scale = Math.min(3, logo.maxScale ?? 3); scale > 1; scale -= 0.5) {
		if (cols * scale <= width * 0.6 && rows * scale <= height * 0.55) return scale;
	}
	return 1;
}

function logoOf(model: Model): Logo {
	const providerName = (model as { providerName?: string }).providerName ?? model.provider;
	return logoFor(model.provider, model.id, providerName);
}

/** Free half rows above the art for jumps; even, so the resting art sits on whole rows. */
const roomFor = (logo: Logo, scale: number) => 2 * Math.round((logo.lift ?? 0) * scale);

/** The pixel rows and the jump height in half rows at `time` ms after the logo appeared. */
function frameAt(logo: Logo, time: number, scale: number): { art: string[]; lift: number } {
	if (!logo.frame || STATIC) return { art: logo.art, lift: 0 };
	const frame = logo.frame(time);
	return { art: frame.art, lift: Math.round(frame.lift * roomFor(logo, scale)) };
}

function logoLines(theme: Theme, model: Model | undefined, width: number, height: number, time: number, withHints = true): string[] {
	if (!model) return [theme.fg("dim", "Select a model with /model")];
	const logo = logoOf(model);
	const scale = scaleFor(logo, width, height - 6);
	const frame = frameAt(logo, time, scale);
	// Room for jumps stays reserved, so the text below does not move.
	let art = drawArt(theme, logo, frame.art, scale, frame.lift, roomFor(logo, scale));
	// Too wide for the terminal: fall back to the wordmark alone.
	if (art.some((line) => visibleWidth(line) > width)) art = [];
	const first = logo.color && typeof logo.color !== "function" ? Object.values(logo.color)[0] : undefined;
	const nameColor = first ?? (typeof logo.color === "function" ? logo.color(0, 0, "#") : undefined);
	const name = [
		nameColor ? theme.style(logo.name, { fg: rgb(nameColor), bold: true }) : theme.bold(logo.name),
		theme.fg("muted", model.name ?? model.id),
	];
	const hints = !withHints ? [] : [
		"",
		theme.fg("dim", "Type a message to start"),
		theme.fg("dim", "/model switch model  ·  /effort  ·  shift+tab mode  ·  / commands"),
	];
	// Rows that don't fit would scroll the art off the top: drop the hints first, then the art.
	const withArt = art.length > 0 ? [...art, "", ...name] : name;
	if (withArt.length + hints.length <= height) return [...withArt, ...hints];
	return withArt.length <= height ? withArt : name;
}

type Node = { children?: unknown[]; render(width: number): string[] };

const contains = (node: Node, target: object): boolean =>
	node === target || (node.children as Node[] | undefined)?.some((child) => contains(child, target)) === true;

/**
 * Rows of everything pi renders besides `header`. Containers on the way to it only
 * stack their children, so they are summed child by child, skipping the header.
 */
function rowsBesides(node: Node, header: object, width: number): number {
	if (node === header) return 0;
	if (!contains(node, header)) return node.render(width).length;
	return (node.children as Node[]).reduce((sum, child) => sum + rowsBesides(child, header, width), 0);
}

function rowsBelow(tui: Node, header: object, width: number): number {
	return contains(tui, header) ? rowsBesides(tui, header, width) : FALLBACK_BELOW;
}

const centrePad = (line: string, width: number) => Math.max(0, Math.floor((width - visibleWidth(line)) / 2));

/** Columns kept free between the lists and the logo beside them. */
const GAP = 2;

/**
 * `room` rows: the logo from row `top`, `list` at the bottom left and `right` at the
 * bottom right (one column in from the edge). Where they share a row, each logo line
 * keeps its centred position; undefined when a line would hit one of the lists.
 */
export function compose(logo: string[], top: number, list: string[], room: number, width: number, right: string[] = []): string[] | undefined {
	const listTop = room - list.length;
	const rightTop = room - right.length;
	const rows: string[] = [];
	for (let r = 0; r < Math.max(room, top + logo.length); r++) {
		const line = logo[r - top] ?? "";
		const item = (r >= listTop ? list[r - listTop] : undefined) ?? "";
		const end = (r >= rightTop ? right[r - rightTop] : undefined) ?? "";
		const pad = line === "" ? visibleWidth(item) : centrePad(line, width);
		if (line !== "" && item !== "" && visibleWidth(item) + GAP > pad) return undefined;
		let row = line === "" ? item : `${item}${" ".repeat(pad - visibleWidth(item))}${line}`;
		if (end !== "") {
			const free = width - 1 - visibleWidth(end) - visibleWidth(row);
			if (free < (row.trim() === "" ? 0 : GAP)) return undefined;
			row += `${" ".repeat(free)}${end}`;
		}
		rows.push(row);
	}
	return rows;
}

function chatIsEmpty(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

export default function (pi: ExtensionAPI) {
	let shown = false;
	let model: Model | undefined;
	let requestRender: (() => void) | undefined;
	/** When the current logo appeared; its animation starts there. */
	let since = Date.now();
	let ticker: ReturnType<typeof setInterval> | undefined;
	/** Restarts the animation of the shown header, e.g. after a model switch. */
	let restart: (() => void) | undefined;

	/** chat-view's extension list, drawn at the bottom left of the header. */
	let list: string[] = [];
	pi.events.on(EXTENSION_LIST_CHANNEL, (data) => {
		const offer = data as ExtensionListOffer;
		offer.take();
		// pi indents widgets by one column; the list keeps that look.
		list = offer.lines.map((line) => ` ${line}`);
		requestRender?.();
	});

	/** pi-bridge's open wishes, drawn at the bottom right of the header. */
	let wishes: string[] = [];
	/** Opens pi-bridge's wish popup at a clicked row of `wishes`. */
	let openWish: ((row: number) => void) | undefined;
	pi.events.on(WISH_LIST_CHANNEL, (data) => {
		const offer = data as WishListOffer;
		offer.take();
		wishes = offer.lines;
		openWish = offer.open;
		requestRender?.();
	});

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	/** Re-renders whenever the animation reaches a new frame. */
	const startTicker = (scaleNow: () => number) => {
		stopTicker();
		if (STATIC || !model || !logoOf(model).frame) return;
		let last = "";
		ticker = setInterval(() => {
			if (!model) return;
			const logo = logoOf(model);
			const frame = frameAt(logo, Date.now() - since, scaleNow());
			const key = `${frame.lift}|${frame.art.join("")}`;
			if (key === last) return;
			last = key;
			requestRender?.();
		}, TICK_MS);
		ticker.unref?.();
	};

	const show = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const previous = model && logoOf(model).name;
		model = ctx.model;
		// A new logo plays its entrance again.
		if (!model || previous !== logoOf(model).name) since = Date.now();
		if (shown) {
			restart?.();
			requestRender?.();
			return;
		}
		shown = true;
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			/** Rows left for the header, as of the last render. */
			let room = tui.terminal.rows - FALLBACK_BELOW;
			const scaleNow = () => (model ? scaleFor(logoOf(model), tui.terminal.columns, room - 6) : 1);
			restart = () => startTicker(scaleNow);
			restart();
			/** Where the wishes were drawn last (their first row and the width), for clicks on them. */
			let wishesAt: { top: number; width: number } | undefined;
			const header = {
				render(width: number): string[] {
					const { lines, withWishes } = header.layout(width);
					wishesAt = withWishes && wishes.length > 0 ? { top: room - wishes.length, width } : undefined;
					return lines;
				},
				layout(width: number): { lines: string[]; withWishes: boolean } {
					// pi lays out top-down without pinning the editor to the bottom, so the
					// header has to leave room for everything below it, measured, not guessed.
					const rows = tui.terminal.rows;
					room = rows - rowsBelow(tui as unknown as Node, header, width);
					const time = Date.now() - since;
					const placed = (lines: string[], bottom: number) =>
						Math.max(0, Math.min(Math.floor((rows - lines.length) / 2), bottom - lines.length));
					// Beside the list where every shared row has room (the wide hints may have to go),
					// otherwise above it.
					for (const withHints of [true, false]) {
						const beside = logoLines(theme, model, width, room, time, withHints);
						const composed = compose(beside, placed(beside, room), list, room, width, wishes);
						if (composed) return { lines: composed, withWishes: true };
					}
					const below = Math.max(list.length, wishes.length);
					const above = logoLines(theme, model, width, room - below, time);
					const composed = compose(above, placed(above, room - below), list, room, width, wishes);
					if (composed) return { lines: composed, withWishes: true };
					// The lists do not fit beside each other: the wishes give way.
					return { lines: compose(above, placed(above, room - list.length), list, room, width) ?? above, withWishes: false };
				},
				handleMouse(event: TuiMouseEvent) {
					if (!wishesAt || !openWish) return undefined;
					return rowClick(event, wishes, wishesAt.top, wishesAt.width, openWish);
				},
				invalidate() {},
				dispose() {
					stopTicker();
				},
			};
			return header;
		});
	};

	const hide = (ctx: ExtensionContext) => {
		if (!shown) return;
		shown = false;
		stopTicker();
		requestRender = undefined;
		restart = undefined;
		try {
			ctx.ui.setHeader(undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (chatIsEmpty(ctx)) show(ctx);
		else hide(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (shown) show(ctx);
	});

	// The first message replaces the logo with pi's usual header.
	pi.on("agent_start", async (_event, ctx) => hide(ctx));
	pi.on("message_start", async (_event, ctx) => hide(ctx));

	pi.on("session_shutdown", async (_event, ctx) => hide(ctx));

	pi.registerCommand("logo", {
		description: "Show the provider logo (until the next message)",
		handler: async (_arg, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The logo needs the interactive terminal UI.", "warning");
				return;
			}
			show(ctx);
		},
	});

	const costumeChoices = () => ["auto", "none", ...Object.keys(COSTUMES)];
	pi.registerCommand("costume", {
		description: "Dress Clawd and Gravi up: a costume, none, or auto (by the date)",
		getArgumentCompletions: (prefix) => {
			const matches = costumeChoices().filter((c) => c.toLowerCase().startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (arg, ctx) => {
			let choice = arg?.trim();
			if (!choice) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Usage: /costume <${costumeChoices().join(" | ")}>`, "error");
					return;
				}
				const picked = await ctx.ui.select(`Clawd's costume (now: ${costumeName() ?? "none"})`, costumeChoices());
				if (!picked) return;
				choice = picked;
			}
			const wanted = choice.toLowerCase();
			const name = costumeChoices().find((c) => c.toLowerCase() === wanted);
			if (!name) {
				ctx.ui.notify(`Unknown costume "${choice}". Choose from: ${costumeChoices().join(", ")}`, "error");
				return;
			}
			chooseCostume(name === "auto" ? undefined : name);
			const today = costumeFor(new Date()) ?? "none";
			ctx.ui.notify(name === "auto" ? `Clawd dresses by the date again (today: ${today})` : `Clawd wears: ${name}`, "info");
			// Show the new look right away, entrance included.
			if (ctx.mode === "tui") {
				since = Date.now();
				show(ctx);
			}
		},
	});
}
