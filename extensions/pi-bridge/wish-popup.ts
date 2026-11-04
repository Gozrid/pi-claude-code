/**
 * The wish popup: pi's wish list to read in full.
 *
 *   ╭─ Wishes ─────────────────────────────────────────────────────────╮
 *   │ Active 3   Open 2   In progress 1   Done 4   All 7       / mcp    │
 *   │                                                                    │
 *   │ ╭────────────────────╮ │ Wishes popup with list and preview        │
 *   │ │ ◐ #3 Wishes popup  │ │ in progress · added 2026-11-02            │
 *   │ │ added 2026-11-02   │ │ ~/Projekte/Privat/UCMeter                 │
 *   │ │ A popup with list… │ │                                           │
 *   │ ╰────────────────────╯ │ The description, rendered as Markdown …   │
 *   ╰─ ↑↓ select · pgup/pgdn scroll · tab filter · / search · s status ╯
 *
 * The list on the left, a box per wish as wide as the subagent popup's, the
 * selected wish on the right. Tabs filter by status
 * (active = open and in progress, the default), `/` searches titles and
 * descriptions. Keys: s cycles the status, enter puts a prompt to work on the
 * wish into the editor, e opens the file in the editor app, c copies the wish,
 * esc closes. The mouse selects, switches tabs and scrolls each column. On a
 * narrow terminal it shows one column: the list, enter opens the wish, esc goes
 * back.
 *
 * It opens like /usage (shared/opening.ts): the frame unfolds from the middle
 * (renderUnfolding), then the title is typed and the rows appear from the top
 * (render with `opening`).
 *
 * WishBrowser is the component; index.ts opens it as an overlay, plays the
 * opening and does what its callbacks ask for.
 */

import { hyperlink, Key, matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { openingTitle, shownRows } from "../shared/opening.ts";
import { type Wish, WISH_STATUSES, type WishStatus } from "./wishes.ts";

type Theme = {
	fg(color: any, text: string): string;
	bg(color: any, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
};

export const FILTERS = [
	{ label: "Active", statuses: ["open", "in progress"] },
	{ label: "Open", statuses: ["open"] },
	{ label: "In progress", statuses: ["in progress"] },
	{ label: "Done", statuses: ["done"] },
	{ label: "All", statuses: [...WISH_STATUSES] },
] as const satisfies { label: string; statuses: readonly WishStatus[] }[];

/** Below this inner width the popup shows one column at a time. */
export const NARROW = 64;
/** Rows of one box in the list, its border included (as in the subagent popup). */
export const BOX_ROWS = 5;

const SYMBOL: Record<WishStatus, string> = { open: "○", "in progress": "◐", done: "✓" };
const COLOR: Record<WishStatus, string> = { open: "muted", "in progress": "accent", done: "success" };
/** Columns between the list and the preview: " │ ". */
const DIVIDER = 3;

/** Wishes that match a filter and a search (all words, in title, short title or description). */
export function filterWishes(wishes: Wish[], filter: number, query: string): Wish[] {
	const statuses: readonly WishStatus[] = FILTERS[filter].statuses;
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = wishes.filter((w) => {
		if (!statuses.includes(w.status)) return false;
		const text = `#${w.id} ${w.title} ${w.short} ${w.description}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
	// Like the empty chat: in progress first, then the rest, each oldest first.
	return [...shown.filter((w) => w.status === "in progress"), ...shown.filter((w) => w.status !== "in progress")];
}

/** The status after `status` when cycling with `s`. */
export const nextStatus = (status: WishStatus): WishStatus => WISH_STATUSES[(WISH_STATUSES.indexOf(status) + 1) % WISH_STATUSES.length];

/** The prompt `enter` puts into the editor. */
export const workPrompt = (wish: Wish) => `Let's work on wish #${wish.id} "${wish.title}" from pi's wish list.`;

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

export interface WishBrowserOptions {
	theme: Theme;
	/** The wish list as it is now; called again on reload(). */
	load(): Wish[];
	/** Markdown for the preview, `width` columns wide. */
	markdown(text: string, width: number): string[];
	/** Rows the popup may take, frame included. */
	rows(): number;
	requestRender(): void;
	/** The wish to select first; with the active filter it may be done, then "All" is shown. */
	selected?: number;
	setStatus(id: number, status: WishStatus): void;
	work(wish: Wish): void;
	edit(): void;
	copy(wish: Wish): void;
	close(): void;
}

export class WishBrowser {
	private wishes: Wish[] = [];
	private filter = 0;
	private query = "";
	private searching = false;
	private selectedId: number | undefined;
	private listTop = 0;
	private previewTop = 0;
	/** Narrow mode: showing the selected wish instead of the list. */
	private detail = false;
	/** Where things were drawn last, for the mouse. */
	private layout = { width: 0, listWidth: 0, bodyTop: 3, bodyRows: 0, narrow: false, tabs: [] as { from: number; to: number }[] };

	private readonly o: WishBrowserOptions;

	constructor(o: WishBrowserOptions) {
		this.o = o;
		this.wishes = o.load();
		this.selectedId = o.selected ?? this.shown()[0]?.id;
		const wanted = this.wishes.find((w) => w.id === o.selected);
		if (wanted && !(FILTERS[0].statuses as readonly WishStatus[]).includes(wanted.status)) this.filter = FILTERS.length - 1;
	}

	/** Reads the list again, e.g. after the model changed a status. */
	reload(): void {
		this.wishes = this.o.load();
		this.o.requestRender();
	}

	private shown(): Wish[] {
		return filterWishes(this.wishes, this.filter, this.query);
	}

	/** The selected wish among those shown; the first one if it is filtered out. */
	private current(shown = this.shown()): Wish | undefined {
		return shown.find((w) => w.id === this.selectedId) ?? shown[0];
	}

	private select(wish: Wish | undefined): void {
		if (wish?.id !== this.selectedId) this.previewTop = 0;
		this.selectedId = wish?.id;
	}

	private move(by: number): void {
		const shown = this.shown();
		if (shown.length === 0) return;
		const at = Math.max(0, shown.indexOf(this.current(shown)!));
		this.select(shown[Math.max(0, Math.min(shown.length - 1, at + by))]);
	}

	private setFilter(filter: number): void {
		this.filter = (filter + FILTERS.length) % FILTERS.length;
		this.listTop = 0;
		this.select(this.current());
	}

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	/**
	 * The popup. `opening`: ms since it opened, while the opening still plays
	 * after the frame has unfolded; the title is typed and the rows appear.
	 */
	render(width: number, opening?: number): string[] {
		const t = this.o.theme;
		const inner = Math.max(10, width - 4);
		const narrow = inner < NARROW;
		const height = this.height();
		const bodyRows = height - 2 - 2;
		const shown = this.shown();
		const wish = this.current(shown);
		this.selectedId = wish?.id;
		if (!wish) this.detail = false;

		const lines = [this.tabsLine(inner), ""];
		const listWidth = narrow ? inner : Math.min(44, Math.max(26, Math.floor(inner * 0.32)));
		const previewWidth = narrow ? inner : inner - listWidth - DIVIDER;
		const list = narrow && this.detail ? [] : this.listLines(shown, wish, listWidth, bodyRows);
		const preview = narrow && !this.detail ? [] : this.previewLines(wish, previewWidth, bodyRows);
		for (let r = 0; r < bodyRows; r++) {
			if (narrow) lines.push(this.detail ? preview[r] ?? "" : list[r] ?? "");
			else lines.push(`${pad(list[r] ?? "", listWidth)}${t.fg("borderMuted", " │ ")}${preview[r] ?? ""}`);
		}
		this.layout = { ...this.layout, width, listWidth, bodyTop: 3, bodyRows, narrow };
		if (opening === undefined) return frame(t, width, t.bold("Wishes"), this.hint(narrow), lines.map((l) => pad(l, inner)));
		const visible = shownRows(opening, lines.length);
		return frame(t, width, openingTitle(t, "Wishes", opening), this.hint(narrow), lines.map((l, i) => pad(i < visible ? l : "", inner)));
	}

	/** Rows the popup takes, frame included. */
	height(): number {
		return Math.max(8, this.o.rows());
	}

	/** The empty frame while it unfolds, `rows` high (borders included). */
	renderUnfolding(width: number, rows: number): string[] {
		const blank = " ".repeat(Math.max(0, width - 4));
		return frame(this.o.theme, width, "", "", new Array(Math.max(0, rows - 2)).fill(blank));
	}

	private tabsLine(inner: number): string {
		const t = this.o.theme;
		const tabs: { from: number; to: number }[] = [];
		let line = "";
		FILTERS.forEach((f, i) => {
			const count = filterWishes(this.wishes, i, this.query).length;
			const label = ` ${f.label} ${count} `;
			if (line) line += " ";
			tabs.push({ from: visibleWidth(line), to: visibleWidth(line) + visibleWidth(label) });
			line += i === this.filter ? t.bg("selectedBg", t.bold(t.fg("accent", label))) : t.fg("muted", label);
		});
		this.layout.tabs = tabs;
		if (this.searching || this.query) {
			const search = this.searching ? `/ ${this.query}${t.fg("accent", "▏")}` : t.fg("muted", `/ ${this.query}`);
			const free = inner - visibleWidth(line) - visibleWidth(search);
			if (free >= 2) line += `${" ".repeat(free)}${search}`;
			else line = truncateToWidth(search, inner);
		}
		return line;
	}

	private listLines(shown: Wish[], wish: Wish | undefined, width: number, rows: number): string[] {
		const t = this.o.theme;
		if (shown.length === 0) return [t.fg("dim", this.query ? "No wish matches." : "No wishes here.")];
		const fit = Math.max(1, Math.floor(rows / BOX_ROWS));
		const at = Math.max(0, shown.indexOf(wish!));
		this.listTop = Math.max(0, Math.min(this.listTop, shown.length - fit));
		if (at < this.listTop) this.listTop = at;
		if (at >= this.listTop + fit) this.listTop = at - fit + 1;
		const lines = shown.slice(this.listTop, this.listTop + fit).flatMap((w) => this.box(w, w === wish, width));
		if (this.listTop > 0) lines[0] = `${truncateToWidth(lines[0], width - 2, "")}${t.fg("dim", " ↑")}`;
		if (this.listTop + fit < shown.length) {
			const last = Math.min(rows, lines.length) - 1;
			lines[last] = `${truncateToWidth(lines[last], width - 2, "")}${t.fg("dim", " ↓")}`;
		}
		return lines;
	}

	/** One wish as a box of BOX_ROWS rows: title, when it was added (or done), the start of its description. */
	private box(wish: Wish, selected: boolean, width: number): string[] {
		const t = this.o.theme;
		const room = Math.max(1, width - 4);
		const border = (s: string) => t.fg(selected ? "borderAccent" : "borderMuted", s);
		const row = (text: string) => {
			const fitted = pad(truncateToWidth(text, room), room);
			return `${border("│")} ${selected ? t.bg("selectedBg", fitted) : fitted} ${border("│")}`;
		};
		const name = `#${wish.id} ${wish.short}`;
		const title = `${t.fg(COLOR[wish.status], SYMBOL[wish.status])} ${selected ? t.bold(t.fg("accent", name)) : t.bold(name)}`;
		// The symbol already tells the status; the date fits beside nothing else in a narrow box.
		const meta = t.fg("muted", wish.done ? `done ${wish.done}` : wish.added ? `added ${wish.added}` : wish.status);
		const start = t.fg("dim", wish.description.replace(/\s+/g, " ").trim());
		return [border(`╭${"─".repeat(width - 2)}╮`), row(title), row(meta), row(start), border(`╰${"─".repeat(width - 2)}╯`)];
	}

	/** All lines of the preview, before scrolling. */
	private previewAll(wish: Wish | undefined, width: number): string[] {
		const t = this.o.theme;
		if (!wish) return [];
		const meta = [
			t.fg(COLOR[wish.status], `${SYMBOL[wish.status]} ${wish.status}`),
			`#${wish.id}`,
			...(wish.added ? [`added ${wish.added}`] : []),
			...(wish.done ? [`done ${wish.done}`] : []),
		].join(t.fg("dim", " · "));
		const project = wish.project
			? [t.fg("dim", hyperlink(truncateToWidth(tilde(wish.project), width), pathToFileURL(wish.project).href))]
			: [];
		return [
			...wrapTextWithAnsi(t.bold(wish.title), width),
			truncateToWidth(meta, width),
			...project,
			"",
			...this.o.markdown(wish.description, width),
		];
	}

	private previewLines(wish: Wish | undefined, width: number, rows: number): string[] {
		const all = this.previewAll(wish, width);
		this.previewTop = Math.max(0, Math.min(this.previewTop, all.length - rows));
		const lines = all.slice(this.previewTop, this.previewTop + rows);
		const t = this.o.theme;
		// Marks that there is more above or below.
		const mark = (line: string, arrow: string) => `${truncateToWidth(line, width - 2, "", true)}${t.fg("dim", ` ${arrow}`)}`;
		if (this.previewTop > 0 && lines.length > 0) lines[0] = mark(lines[0], "↑");
		if (this.previewTop + rows < all.length) lines[rows - 1] = mark(lines[rows - 1] ?? "", "↓");
		return lines;
	}

	private hint(narrow: boolean): string {
		const t = this.o.theme;
		if (this.searching) return t.fg("dim", "type to search · enter keep · esc clear");
		const parts = narrow
			? this.detail
				? ["↑↓ scroll", "s status", "⏎ work on it", "esc back"]
				: ["⏎ open", "tab filter", "/ search", "esc close"]
			: ["↑↓ select", "pgup/pgdn scroll", "tab filter", "/ search", "s status", "⏎ work on it", "e edit", "c copy", "esc close"];
		return t.fg("dim", parts.join(" · "));
	}

	invalidate(): void {}

	// -------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.searching) this.searchInput(data);
		else this.keyInput(data);
		this.o.requestRender();
	}

	private searchInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.searching = false;
			this.query = "";
		} else if (matchesKey(data, Key.enter)) this.searching = false;
		else if (matchesKey(data, Key.backspace)) this.query = this.query.slice(0, -1);
		else if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.tab)) this.setFilter(this.filter + 1);
		else if (data.length === 1 && data >= " ") this.query += data;
		else return;
		this.listTop = 0;
		this.select(this.current());
	}

	private keyInput(data: string): void {
		const narrow = this.layout.narrow;
		const wish = this.current();
		const page = Math.max(1, this.layout.bodyRows - 2);
		const scrolling = narrow && this.detail;
		if (matchesKey(data, Key.escape) || data === "q") {
			if (scrolling) this.detail = false;
			else this.o.close();
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (scrolling) this.previewTop = Math.max(0, this.previewTop - 1);
			else this.move(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (scrolling) this.previewTop += 1;
			else this.move(1);
		} else if (matchesKey(data, Key.shift("up"))) this.previewTop = Math.max(0, this.previewTop - 1);
		else if (matchesKey(data, Key.shift("down"))) this.previewTop += 1;
		else if (matchesKey(data, Key.pageUp)) this.previewTop = Math.max(0, this.previewTop - page);
		else if (matchesKey(data, Key.pageDown) || (scrolling && data === " ")) this.previewTop += page;
		else if (matchesKey(data, Key.home)) this.move(-Infinity);
		else if (matchesKey(data, Key.end)) this.move(Infinity);
		else if (matchesKey(data, Key.tab)) this.setFilter(this.filter + 1);
		else if (matchesKey(data, Key.shift("tab"))) this.setFilter(this.filter - 1);
		else if (data === "/") {
			this.searching = true;
			this.detail = false;
		} else if (matchesKey(data, Key.enter)) {
			if (!wish) return;
			if (narrow && !this.detail) this.detail = true;
			else this.o.work(wish);
		} else if (data === "s" && wish) {
			const at = this.shown().indexOf(wish);
			this.o.setStatus(wish.id, nextStatus(wish.status));
			this.wishes = this.o.load();
			// Where the filter no longer shows the wish, the one in its place is selected.
			const shown = this.shown();
			if (!shown.some((w) => w.id === wish.id)) this.select(shown[Math.min(at, shown.length - 1)]);
		} else if (data === "e") this.o.edit();
		else if (data === "c" && wish) this.o.copy(wish);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { bodyTop, bodyRows, listWidth, narrow, tabs } = this.layout;
		// Inside the frame: one border column and one space on the left.
		const x = event.x - 2;
		const y = event.y;
		const inList = !narrow ? x < listWidth : !this.detail;
		if (event.type === "wheel") {
			const by = Math.sign(event.wheelDelta ?? 0);
			if (inList) this.move(by);
			else this.previewTop = Math.max(0, this.previewTop + (event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press" || event.type === "release") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (y === 1) {
			const tab = tabs.findIndex((t) => x >= t.from && x < t.to);
			if (tab >= 0) this.setFilter(tab);
			return { handled: true };
		}
		const row = y - bodyTop;
		if (row >= 0 && row < bodyRows && inList) {
			const wish = this.shown()[this.listTop + Math.floor(row / BOX_ROWS)];
			if (wish) {
				this.select(wish);
				if (narrow) this.detail = true;
				else if ((event.clickCount ?? 1) >= 2) this.o.work(wish);
			}
		}
		return { handled: true };
	}
}

const pad = (line: string, width: number) => {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

/** A rounded frame around `lines` (each `width - 4` wide), with `title` and `hint` in the borders. */
function frame(theme: Theme, width: number, title: string, hint: string, lines: string[]): string[] {
	const border = (text: string) => theme.fg("borderAccent", text);
	const edge = (left: string, label: string, right: string) => {
		const room = width - 2;
		const text = truncateToWidth(label, Math.max(0, room - 4), "…");
		const filler = Math.max(0, room - 3 - visibleWidth(text));
		return text ? `${border(`${left}─ `)}${text}${border(` ${"─".repeat(filler)}${right}`)}` : border(`${left}${"─".repeat(room)}${right}`);
	};
	return [edge("╭", title, "╮"), ...lines.map((line) => `${border("│")} ${line} ${border("│")}`), edge("╰", hint, "╯")];
}
