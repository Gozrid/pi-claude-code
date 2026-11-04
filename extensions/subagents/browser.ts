/**
 * The subagent popup: every subagent of the session in a box on the left, the
 * selected one's output on the right, live while it runs.
 *
 *   ╭─ Subagents ──────────────────────────────────────────────────────╮
 *   │  All 4   Running 1   Done 3   Stopped 0                    ● live │
 *   │                                                                    │
 *   │ ╭──────────────────────────╮ │ Review PR 13                        │
 *   │ │ ◐ Review PR 13           │ │ ◐ running · general-purpose · 1m 2s │
 *   │ │ general-purpose · 1m 2s  │ │                                     │
 *   │ │ Bash gh pr diff 13       │ │ Prompt                              │
 *   │ ╰──────────────────────────╯ │ You are reviewing …                 │
 *   │ ╭──────────────────────────╮ │                                     │
 *   │ │ ✓ Find callers           │ │ ● Bash gh pr diff 13                │
 *   │ │ Explore · 12s            │ │   ⎿ diff --git a/…                  │
 *   ╰─ ↑↓ select · pgup/pgdn scroll · end follow · tab filter · esc close ╯
 *
 * Tabs filter by status like the wish popup's: all (the default), running,
 * done or stopped; Tab and Shift+Tab switch, a click on a tab picks it.
 * The output follows the newest step until scrolled up; End (or scrolling to
 * the bottom) follows again. The mouse selects a box and scrolls each column.
 * On a narrow terminal it shows one column: the boxes, enter opens one, esc
 * goes back.
 *
 * It opens like the wish popup (shared/opening.ts): render with `opening`
 * types the title and lets the rows appear; renderUnfolding draws the frame.
 */

import { Key, matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Subagent, SubagentStatus, SubagentStep } from "../shared/agent-bus.ts";
import { formatElapsed } from "../shared/format.ts";
import { openingTitle, shownRows } from "../shared/opening.ts";
import { COLOR, runTime, sortAgents, SYMBOL, type Theme, toolLine } from "./panel.ts";

type FullTheme = Theme & { bg(color: any, text: string): string; inverse(text: string): string };

/** Below this inner width the popup shows one column at a time. */
export const NARROW = 64;
/** Rows of one box in the list, its border included. */
export const BOX_ROWS = 5;
/** Columns between the boxes and the output: " │ ". */
const DIVIDER = 3;
/** Lines of the prompt shown before it is cut. */
const PROMPT_LINES = 8;
/** Lines of a thought shown before it is cut. */
const THINKING_LINES = 12;
/** Steps set off by a blank line before and after, unlike tool calls and their results. */
const spaced = (kind: SubagentStep["kind"] | undefined) => kind === "text" || kind === "prompt" || kind === "thinking";
const TITLE = "Subagents";

export const FILTERS = [
	{ label: "All", statuses: ["running", "done", "stopped"] },
	{ label: "Running", statuses: ["running"] },
	{ label: "Done", statuses: ["done"] },
	{ label: "Stopped", statuses: ["stopped"] },
] as const satisfies { label: string; statuses: readonly SubagentStatus[] }[];

/** The subagents a filter shows, in the popup's order. */
export function filterAgents(agents: Subagent[], filter: number): Subagent[] {
	const statuses: readonly SubagentStatus[] = FILTERS[filter].statuses;
	return sortAgents(agents.filter((a) => statuses.includes(a.status)));
}

export interface SubagentBrowserOptions {
	theme: FullTheme;
	/** The subagents as they are now; called on every render. */
	load(): Subagent[];
	/** Markdown for the output, `width` columns wide. */
	markdown(text: string, width: number): string[];
	/** Rows the popup may take, frame included. */
	rows(): number;
	requestRender(): void;
	/** The subagent to select first. */
	selected?: string;
	close(): void;
}

export class SubagentBrowser {
	private selectedId: string | undefined;
	private filter = 0;
	private listTop = 0;
	private outputTop = 0;
	/** Keeps the output at its newest step. */
	private follow = true;
	/** Narrow mode: showing the selected subagent instead of the list. */
	private detail = false;
	/** Where things were drawn last, for the mouse and the keys. */
	private layout = { listWidth: 0, bodyTop: 3, bodyRows: 0, narrow: false, outputMax: 0, tabs: [] as { from: number; to: number }[] };
	/** Rendered lines per step and width; steps are only ever appended. */
	private cache = new WeakMap<SubagentStep, { width: number; lines: string[] }>();

	private readonly o: SubagentBrowserOptions;

	constructor(o: SubagentBrowserOptions) {
		this.o = o;
		this.selectedId = o.selected;
	}

	private shown(agents = this.o.load()): Subagent[] {
		return filterAgents(agents, this.filter);
	}

	private current(shown = this.shown()): Subagent | undefined {
		return shown.find((a) => a.id === this.selectedId) ?? shown[0];
	}

	private select(agent: Subagent | undefined): void {
		if (agent?.id !== this.selectedId) {
			this.outputTop = 0;
			this.follow = true;
		}
		this.selectedId = agent?.id;
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
		this.detail = false;
		this.select(this.current());
	}

	private scroll(by: number): void {
		this.outputTop = Math.max(0, Math.min(this.layout.outputMax, (this.follow ? this.layout.outputMax : this.outputTop) + by));
		this.follow = this.outputTop >= this.layout.outputMax;
	}

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	/** The popup. `opening`: ms since it opened, while the opening still plays. */
	render(width: number, opening?: number, now = Date.now()): string[] {
		const t = this.o.theme;
		const inner = Math.max(10, width - 4);
		const narrow = inner < NARROW;
		const bodyRows = this.height() - 2 - 2;
		const all = this.o.load();
		const shown = this.shown(all);
		const agent = this.current(shown);
		if (agent?.id !== this.selectedId) this.select(agent);
		if (!agent) this.detail = false;

		const listWidth = narrow ? inner : Math.min(44, Math.max(26, Math.floor(inner * 0.32)));
		const outputWidth = narrow ? inner : inner - listWidth - DIVIDER;
		const lines = [this.tabsLine(all, agent, inner), ""];
		const list = narrow && this.detail ? [] : this.listLines(shown, agent, listWidth, bodyRows, now);
		const output = narrow && !this.detail ? [] : this.outputLines(agent, outputWidth, bodyRows, now);
		for (let r = 0; r < bodyRows; r++) {
			if (narrow) lines.push(this.detail ? output[r] ?? "" : list[r] ?? "");
			else lines.push(`${pad(list[r] ?? "", listWidth)}${t.fg("borderMuted", " │ ")}${output[r] ?? ""}`);
		}
		this.layout = { ...this.layout, listWidth, bodyTop: 3, bodyRows, narrow };
		const hint = this.hint(narrow);
		if (opening === undefined) return frame(t, width, t.bold(TITLE), hint, lines.map((l) => pad(l, inner)));
		const visible = shownRows(opening, lines.length);
		return frame(t, width, openingTitle(t, TITLE, opening), hint, lines.map((l, i) => pad(i < visible ? l : "", inner)));
	}

	/** Rows the popup takes, frame included. */
	height(): number {
		return Math.max(BOX_ROWS + 6, this.o.rows());
	}

	/** The empty frame while it unfolds, `rows` high (borders included). */
	renderUnfolding(width: number, rows: number): string[] {
		const blank = " ".repeat(Math.max(0, width - 4));
		return frame(this.o.theme, width, "", "", new Array(Math.max(0, rows - 2)).fill(blank));
	}

	/** The filter tabs with their counts, and whether the output follows live. */
	private tabsLine(all: Subagent[], agent: Subagent | undefined, inner: number): string {
		const t = this.o.theme;
		const tabs: { from: number; to: number }[] = [];
		let left = "";
		FILTERS.forEach((f, i) => {
			const label = ` ${f.label} ${filterAgents(all, i).length} `;
			if (left) left += " ";
			tabs.push({ from: visibleWidth(left), to: visibleWidth(left) + visibleWidth(label) });
			left += i === this.filter ? t.bg("selectedBg", t.bold(t.fg("accent", label))) : t.fg("muted", label);
		});
		this.layout.tabs = tabs;
		const live = agent?.status === "running" ? (this.follow ? t.fg("accent", "● live") : t.fg("dim", "○ paused · end follows")) : "";
		const free = inner - visibleWidth(left) - visibleWidth(live);
		return free >= 1 ? `${left}${" ".repeat(free)}${live}` : truncateToWidth(left, inner);
	}

	private listLines(shown: Subagent[], agent: Subagent | undefined, width: number, rows: number, now: number): string[] {
		if (shown.length === 0) return [this.o.theme.fg("dim", this.filter === 0 ? "No subagents in this session yet." : "No subagents here.")];
		const fit = Math.max(1, Math.floor(rows / BOX_ROWS));
		const at = Math.max(0, shown.indexOf(agent!));
		this.listTop = Math.max(0, Math.min(this.listTop, shown.length - fit));
		if (at < this.listTop) this.listTop = at;
		if (at >= this.listTop + fit) this.listTop = at - fit + 1;
		const lines = shown.slice(this.listTop, this.listTop + fit).flatMap((a) => this.box(a, a === agent, width, now));
		const t = this.o.theme;
		if (this.listTop > 0) lines[0] = `${truncateToWidth(lines[0], width - 2, "")}${t.fg("dim", " ↑")}`;
		if (this.listTop + fit < shown.length) {
			const last = Math.min(rows, lines.length) - 1;
			lines[last] = `${truncateToWidth(lines[last], width - 2, "")}${t.fg("dim", " ↓")}`;
		}
		return lines;
	}

	/** One subagent as a box of BOX_ROWS rows. */
	private box(agent: Subagent, selected: boolean, width: number, now: number): string[] {
		const t = this.o.theme;
		const room = Math.max(1, width - 4);
		const border = (s: string) => t.fg(selected ? "borderAccent" : "borderMuted", s);
		const row = (text: string) => {
			const fitted = pad(truncateToWidth(text, room), room);
			return `${border("│")} ${selected ? t.bg("selectedBg", fitted) : fitted} ${border("│")}`;
		};
		const title = `${t.fg(COLOR[agent.status], SYMBOL[agent.status])} ${selected ? t.bold(t.fg("accent", agent.description)) : t.bold(agent.description)}`;
		const meta = t.fg("muted", [agent.type, runTime(agent, now)].filter(Boolean).join(" · "));
		const activity =
			agent.status === "running"
				? t.fg("dim", toolLine(agent) || "starting…")
				: t.fg("dim", `${agent.status} · ${agent.steps.filter((s) => s.kind === "tool").length} tool calls`);
		return [border(`╭${"─".repeat(width - 2)}╮`), row(title), row(meta), row(activity), border(`╰${"─".repeat(width - 2)}╯`)];
	}

	/** All lines of the output, before scrolling. */
	private outputAll(agent: Subagent | undefined, width: number, now: number): string[] {
		const t = this.o.theme;
		if (!agent) return [];
		const meta = [
			t.fg(COLOR[agent.status], `${SYMBOL[agent.status]} ${agent.status}`),
			...(agent.type ? [agent.type] : []),
			...(agent.startedAt !== undefined ? [runTime(agent, now)] : []),
		].join(t.fg("dim", " · "));
		const lines = [...wrapTextWithAnsi(t.bold(agent.description), width), truncateToWidth(meta, width)];
		let previous: SubagentStep["kind"] | undefined = "prompt";
		for (const step of agent.steps) {
			// A blank line between the model's text and the tools around it.
			if (spaced(step.kind) || spaced(previous)) lines.push("");
			lines.push(...this.stepLines(step, width));
			previous = step.kind;
		}
		if (agent.steps.length === 0) lines.push("", t.fg("dim", "Nothing yet."));
		// The CLI writes a step only once it is complete, so a long thought shows nothing new for a while.
		if (agent.status === "running") {
			const since = agent.lastAt ?? agent.startedAt;
			const ago = since !== undefined ? ` · last step ${formatElapsed(Math.max(0, now - since))} ago` : "";
			lines.push("", t.fg("dim", `${SYMBOL.running} working…${ago}`));
		}
		return lines;
	}

	private stepLines(step: SubagentStep, width: number): string[] {
		const cached = this.cache.get(step);
		if (cached?.width === width) return cached.lines;
		const t = this.o.theme;
		let lines: string[];
		if (step.kind === "prompt") {
			const all = wrapTextWithAnsi(step.text, width);
			lines = [t.fg("muted", "Prompt"), ...all.slice(0, PROMPT_LINES).map((l) => t.fg("dim", l))];
			if (all.length > PROMPT_LINES) lines.push(t.fg("dim", `… +${all.length - PROMPT_LINES} lines`));
		} else if (step.kind === "text") {
			lines = this.o.markdown(step.text, width);
		} else if (step.kind === "thinking") {
			const all = wrapTextWithAnsi(step.text, width);
			lines = [t.fg("muted", "Thinking"), ...all.slice(0, THINKING_LINES).map((l) => t.fg("dim", l))];
			if (all.length > THINKING_LINES) lines.push(t.fg("dim", `… +${all.length - THINKING_LINES} lines`));
		} else if (step.kind === "tool") {
			lines = [truncateToWidth(`${t.fg("accent", "●")} ${t.bold(step.name)}${step.detail ? ` ${t.fg("muted", step.detail.replace(/\s+/g, " "))}` : ""}`, width)];
		} else {
			const color = step.isError ? "error" : "dim";
			const text = step.text || (step.isError ? "failed" : "(no output)");
			lines = wrapTextWithAnsi(text, Math.max(1, width - 4)).map((l, i) => t.fg(color, `${i === 0 ? "  ⎿ " : "    "}${l}`));
		}
		this.cache.set(step, { width, lines });
		return lines;
	}

	private outputLines(agent: Subagent | undefined, width: number, rows: number, now: number): string[] {
		const all = this.outputAll(agent, width, now);
		const max = Math.max(0, all.length - rows);
		this.layout.outputMax = max;
		this.outputTop = this.follow ? max : Math.min(this.outputTop, max);
		const lines = all.slice(this.outputTop, this.outputTop + rows);
		const t = this.o.theme;
		const mark = (line: string, arrow: string) => `${truncateToWidth(line, width - 2, "", true)}${t.fg("dim", ` ${arrow}`)}`;
		if (this.outputTop > 0 && lines.length > 0) lines[0] = mark(lines[0], "↑");
		if (this.outputTop + rows < all.length) lines[rows - 1] = mark(lines[rows - 1] ?? "", "↓");
		return lines;
	}

	private hint(narrow: boolean): string {
		const parts = narrow
			? this.detail
				? ["↑↓ scroll", "end follow", "esc back"]
				: ["↑↓ select", "⏎ open", "tab filter", "esc close"]
			: ["↑↓ select", "pgup/pgdn scroll", "end follow", "tab filter", "esc close"];
		return this.o.theme.fg("dim", parts.join(" · "));
	}

	invalidate(): void {
		this.cache = new WeakMap();
	}

	// -------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		const page = Math.max(1, this.layout.bodyRows - 2);
		const scrolling = this.layout.narrow && this.detail;
		if (matchesKey(data, Key.escape) || data === "q") {
			if (scrolling) this.detail = false;
			else this.o.close();
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (scrolling) this.scroll(-1);
			else this.move(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (scrolling) this.scroll(1);
			else this.move(1);
		} else if (matchesKey(data, Key.shift("up"))) this.scroll(-1);
		else if (matchesKey(data, Key.shift("down"))) this.scroll(1);
		else if (matchesKey(data, Key.pageUp)) this.scroll(-page);
		else if (matchesKey(data, Key.pageDown) || (scrolling && data === " ")) this.scroll(page);
		else if (matchesKey(data, Key.home)) {
			this.follow = false;
			this.outputTop = 0;
		} else if (matchesKey(data, Key.end)) this.follow = true;
		else if (matchesKey(data, Key.tab)) this.setFilter(this.filter + 1);
		else if (matchesKey(data, Key.shift("tab"))) this.setFilter(this.filter - 1);
		else if (matchesKey(data, Key.enter)) {
			if (this.layout.narrow && this.current()) this.detail = true;
		} else return;
		this.o.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { bodyTop, bodyRows, listWidth, narrow, tabs } = this.layout;
		// Inside the frame: one border column and one space on the left.
		const x = event.x - 2;
		const inList = !narrow ? x < listWidth : !this.detail;
		if (event.type === "wheel") {
			const by = Math.sign(event.wheelDelta ?? 0);
			if (inList) this.move(by);
			else this.scroll(event.wheelDelta ?? 0);
			this.o.requestRender();
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press" || event.type === "release") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (event.y === 1) {
			const tab = tabs.findIndex((t) => x >= t.from && x < t.to);
			if (tab >= 0) this.setFilter(tab);
			this.o.requestRender();
			return { handled: true };
		}
		const row = event.y - bodyTop;
		if (row >= 0 && row < bodyRows && inList) {
			const agent = this.shown()[this.listTop + Math.floor(row / BOX_ROWS)];
			if (agent) {
				this.select(agent);
				if (narrow) this.detail = true;
			}
		}
		this.o.requestRender();
		return { handled: true };
	}
}

const pad = (line: string, width: number) => {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

/** A rounded frame around `lines` (each `width - 4` wide), with `title` and `hint` in the borders. */
function frame(theme: FullTheme, width: number, title: string, hint: string, lines: string[]): string[] {
	const border = (text: string) => theme.fg("borderAccent", text);
	const edge = (left: string, label: string, right: string) => {
		const room = width - 2;
		const text = truncateToWidth(label, Math.max(0, room - 4), "…");
		const filler = Math.max(0, room - 3 - visibleWidth(text));
		return text ? `${border(`${left}─ `)}${text}${border(` ${"─".repeat(filler)}${right}`)}` : border(`${left}${"─".repeat(room)}${right}`);
	};
	return [edge("╭", title, "╮"), ...lines.map((line) => `${border("│")} ${line} ${border("│")}`), edge("╰", hint, "╯")];
}
