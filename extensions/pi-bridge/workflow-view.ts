/**
 * How a workflow (workflow.ts) looks: a few lines above the editor while it
 * runs, and the popup with the whole tree, used to review the plan before it
 * starts and to follow and steer it while it runs.
 *
 * Above the editor:
 *
 *   ◆ Workflow #3 Build a car model · 12 of 30 done · 3 running · 245.1k tokens · click for the tree
 *   ✓ 1 Wheels 5/5 ── ⠹ 2 Body 3/8 ── ○ 3 Windows 0/6
 *     ⠹ 2.4 Doors · ⠹ 2.5 Roof · ⠹ 2.6 Bonnet
 *
 * The popup (WorkflowBrowser): the tree on a canvas, left to right, every
 * part a box with its mark and title only; the selected part's details beside
 * it. Arrows move between the parts and the canvas follows; shift+arrows, the
 * wheel (shift+wheel sideways) and dragging move the canvas itself.
 *
 *   ╭─ Workflow #3 · Build a car model ──────────────────────────────────────────╮
 *   │ running · 12 of 30 done · 3 running · 245.1k tokens · 3 at once · more →↓  │
 *   │                                                                            │
 *   │ ◆ Build a car model ─┬─ ✓ 1 Wheels ▸            │ 2.2 Doors                │
 *   │                      └─ ⠹ 2 Body ───┬─ ✓ 2.1 Fr │ running · model sonnet   │
 *   │                                     └─ ⠹ 2.2 Do │ within 2 Body            │
 *   ╰─ ↑↓←→ select · space fold · shift+↑↓←→ or drag pan · e title · … ─────────╯
 *
 * In review the keys approve (a) or send the plan back with feedback (f);
 * while it runs they pause and continue (p), cancel (c) and restart (r)
 * parts. Both can edit titles (e) and details (d), add parts next to (n) or
 * inside (i) the selected one, remove (x) parts that have not started and
 * choose the subagents' model (m for the part, M for the workflow) and how many
 * run at once (+/-).
 */

import { Key, matchesKey, sliceByColumn, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, formatTokens } from "../shared/format.ts";
import { SPINNER } from "./steps.ts";
import {
	addPart,
	cancelPart,
	clampParallel,
	editPart,
	MODEL_CHOICES,
	type Part,
	type PartStatus,
	pathTo,
	progressOf,
	removePart,
	restartPart,
	statusOf,
	type Workflow,
} from "./workflow.ts";

type Color = "accent" | "dim" | "muted" | "success" | "error" | "warning" | "text";

/** What the compact lines need of pi's theme. */
export interface WorkflowColors {
	fg(color: Color, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

/** What the popup needs of pi's theme. */
type Theme = {
	fg(color: any, text: string): string;
	bg(color: any, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
};

export function mark(theme: { fg(color: Color, text: string): string }, status: PartStatus, frame: number): string {
	switch (status) {
		case "done":
			return theme.fg("success", "✓");
		case "running":
			return theme.fg("accent", SPINNER[frame % SPINNER.length]);
		case "failed":
			return theme.fg("error", "✗");
		case "skipped":
			return theme.fg("dim", "↷");
		default:
			return theme.fg("dim", "○");
	}
}

const STATE_COLOR: Record<Workflow["state"], Color> = { review: "warning", running: "accent", paused: "warning", done: "success", stopped: "muted" };

/** "12 of 30 done · 3 running · 1 failed · 245.1k tokens" */
export function progressLine(workflow: Workflow): string {
	const p = progressOf(workflow);
	const parts = [`${p.done} of ${p.total} done`];
	if (p.running) parts.push(`${p.running} running`);
	if (p.failed) parts.push(`${p.failed} failed`);
	if (p.tokens) parts.push(`${formatTokens(p.tokens)} tokens`);
	return parts.join(" · ");
}

/** The lines above the editor. */
export function workflowLines(theme: WorkflowColors, workflow: Workflow, width: number, frame = 0): string[] {
	const state = workflow.state === "running" ? "" : theme.fg(STATE_COLOR[workflow.state], ` · ${workflow.state === "review" ? "waiting for your review" : workflow.state}`);
	const head = `${theme.fg("accent", "◆")} ${theme.bold(theme.fg("text", `Workflow #${workflow.id} ${workflow.title}`))}${theme.fg("dim", ` · ${progressLine(workflow)}`)}${state}`;
	const hint = theme.fg("dim", " · click for the tree");
	const lines = [truncateToWidth(visibleWidth(head + hint) <= width ? head + hint : head, width)];
	const big = workflow.parts.map((part) => {
		const p = progressOf(part);
		const count = part.parts.length ? theme.fg("dim", ` ${p.done}/${p.total}`) : "";
		const status = statusOf(part);
		const title = status === "running" ? theme.bold(theme.fg("accent", `${part.id} ${part.title}`)) : theme.fg(status === "pending" ? "dim" : "muted", `${part.id} ${part.title}`);
		return `${mark(theme, status, frame)} ${title}${count}`;
	});
	lines.push(truncateToWidth(big.join(theme.fg("dim", " ── ")), width));
	const running = allLeaves(workflow).filter((p) => p.status === "running" || p.status === "failed");
	if (running.length > 0) {
		const row = running.map((p) => `${mark(theme, p.status, frame)} ${theme.fg(p.status === "failed" ? "error" : "muted", `${p.id} ${p.title}`)}`).join(theme.fg("dim", " · "));
		lines.push(truncateToWidth(`  ${row}`, width));
	}
	return lines;
}

const allLeaves = (workflow: Workflow): Part[] => {
	const out: Part[] = [];
	const walk = (parts: Part[]) => {
		for (const p of parts) p.parts.length ? walk(p.parts) : out.push(p);
	};
	walk(workflow.parts);
	return out;
};

// =============================================================================
// The popup
// =============================================================================

export interface WorkflowBrowserOptions {
	theme: Theme;
	/** The workflow as it is now. */
	workflow(): Workflow;
	/** Changes the workflow; returns an error to show, if any. pi saves it and tells the agent. */
	apply(change: (workflow: Workflow, now: number) => void): string | undefined;
	/** Markdown for the details, `width` columns wide. */
	markdown(text: string, width: number): string[];
	/** Rows the popup may take, frame included. */
	rows(): number;
	requestRender(): void;
	now?(): number;
	/** Review: the user approves the plan. */
	approve?(): void;
	/** Review: the user sends the plan back, with what to change. */
	reject?(feedback: string): void;
	/** Running: pause or continue. */
	pause?(paused: boolean): void;
	close(): void;
}

/** A part on the canvas: the row it stands in, its first column and width. */
export interface CanvasNode {
	part: Part;
	depth: number;
	row: number;
	x: number;
	width: number;
	/** Its title, shortened to fit a box. */
	label: string;
	/** A big part whose parts are hidden. */
	folded: boolean;
}

/** The lines and the root's title drawn between the parts. */
interface CanvasPiece {
	x: number;
	text: string;
	kind: "edge" | "root";
}

/** The whole tree laid out left to right: the workflow, its big parts to the right of it, their parts further right. */
export interface Canvas {
	nodes: CanvasNode[];
	pieces: CanvasPiece[][];
	width: number;
	height: number;
}

/** Widest a part's box gets, its mark included; longer titles end in "…". */
export const LABEL_MAX = 34;
/** Columns from the widest box of one depth to the boxes of the next: " ─┬─ ". */
const GAP = 5;

/**
 * Lays the tree out on a canvas, left to right. A part stands in the row of
 * its first part; its parts follow one below the other, joined to it by a
 * line. Every depth gets a column as wide as its widest box.
 *
 *   ◆ Build a car ─┬─ ○ 1 Wheels ─┬─ ○ 1.1 Screws
 *                  │              └─ ○ 1.2 Rubber
 *                  └─ ○ 2 Body ▸
 */
export function canvasLayout(workflow: Workflow, folded: ReadonlySet<string>): Canvas {
	interface Box {
		part?: Part;
		depth: number;
		label: string;
		width: number;
		folded: boolean;
		kids: Box[];
	}
	const box = (part: Part, depth: number): Box => {
		const isFolded = part.parts.length > 0 && folded.has(part.id);
		const label = truncateToWidth(`${part.id} ${part.title}`, LABEL_MAX - 2 - (isFolded ? 2 : 0), "…");
		const kids = isFolded ? [] : part.parts.map((p) => box(p, depth + 1));
		return { part, depth, label, width: 2 + visibleWidth(label) + (isFolded ? 2 : 0), folded: isFolded, kids };
	};
	const rootLabel = truncateToWidth(`◆ ${workflow.title}`, LABEL_MAX, "…");
	const root: Box = { depth: 0, label: rootLabel, width: visibleWidth(rootLabel), folded: false, kids: workflow.parts.map((p) => box(p, 1)) };
	const columnWidth: number[] = [];
	const measure = (b: Box) => {
		columnWidth[b.depth] = Math.max(columnWidth[b.depth] ?? 0, b.width);
		b.kids.forEach(measure);
	};
	measure(root);
	const columnX = [0];
	for (let d = 1; d < columnWidth.length; d++) columnX[d] = columnX[d - 1] + columnWidth[d - 1] + GAP;
	const nodes: CanvasNode[] = [];
	const pieces: CanvasPiece[][] = [];
	const put = (row: number, piece: CanvasPiece) => (pieces[row] ??= []).push(piece);
	/** Places a box and its parts from `row` on; returns the rows they take. */
	const place = (b: Box, row: number): number => {
		const x = columnX[b.depth];
		if (b.part) nodes.push({ part: b.part, depth: b.depth, row, x, width: b.width, label: b.label, folded: b.folded });
		else put(row, { x, text: b.label, kind: "root" });
		if (b.kids.length === 0) return 1;
		const joint = x + columnWidth[b.depth] + 2;
		put(row, { x: x + b.width, text: ` ${"─".repeat(joint - x - b.width - 1)}`, kind: "edge" });
		const kidRows: number[] = [];
		let next = row;
		for (const kid of b.kids) {
			kidRows.push(next);
			next += place(kid, next);
		}
		const last = kidRows[kidRows.length - 1];
		for (let r = row; r <= last; r++) {
			const at = kidRows.indexOf(r);
			if (at < 0) put(r, { x: joint, text: "│", kind: "edge" });
			else put(r, { x: joint, text: `${b.kids.length === 1 ? "─" : at === 0 ? "┬" : r === last ? "└" : "├"}─ `, kind: "edge" });
		}
		return next - row;
	};
	const height = place(root, 0);
	let width = 0;
	for (const n of nodes) width = Math.max(width, n.x + n.width);
	for (const row of pieces) for (const p of row ?? []) width = Math.max(width, p.x + visibleWidth(p.text));
	return { nodes, pieces, width, height };
}

interface Prompt {
	label: string;
	value: string;
	apply(value: string): void;
}

/** Columns between the canvas and the details: " │ ". */
const DIVIDER = 3;
/** Below this inner width the popup shows the canvas only; enter shows the details. */
export const NARROW = 70;
/** Columns the details keep at least beside the canvas. */
const DETAIL_MIN = 30;
/** Columns and rows shift+arrows move the canvas. */
const PAN_X = 8;
const PAN_Y = 2;

export class WorkflowBrowser {
	private selectedId: string | undefined;
	private folded = new Set<string>();
	/** The canvas column and row at the top left of the view. */
	private view = { x: 0, y: 0 };
	/** Bring the selected part into view at the next render. */
	private follow = true;
	/** A drag on the canvas: where it started, on screen and on the canvas. */
	private drag: { screenX: number; screenY: number; x: number; y: number } | undefined;
	private canvas: Canvas = { nodes: [], pieces: [], width: 0, height: 0 };
	private detailTop = 0;
	private prompt: Prompt | undefined;
	private message: { text: string; error: boolean } | undefined;
	private frame = 0;
	/** Narrow mode: showing the details instead of the canvas. */
	private detail = false;
	private layout = { bodyTop: 3, bodyRows: 0, treeWidth: 0, narrow: false };
	private readonly o: WorkflowBrowserOptions;

	constructor(o: WorkflowBrowserOptions) {
		this.o = o;
		const workflow = o.workflow();
		// Start at the first part that runs or waits; done big parts folded.
		for (const part of workflow.parts) if (part.parts.length && statusOf(part) === "done") this.folded.add(part.id);
		const first = allLeaves(workflow).find((p) => p.status === "running" || p.status === "failed") ?? allLeaves(workflow).find((p) => p.status === "pending");
		this.selectedId = first?.id ?? workflow.parts[0]?.id;
	}

	get review(): boolean {
		return this.o.workflow().state === "review";
	}

	/** Moves the spinners on. */
	tick(): void {
		this.frame++;
	}

	private nodes(): CanvasNode[] {
		this.canvas = canvasLayout(this.o.workflow(), this.folded);
		return this.canvas.nodes;
	}

	private current(nodes = this.nodes()): CanvasNode | undefined {
		const found = nodes.find((n) => n.part.id === this.selectedId);
		if (found) return found;
		// A removed or folded part: its closest visible parent, else the first part.
		const trail = this.selectedId?.split(".") ?? [];
		while (trail.length) {
			trail.pop();
			const parent = nodes.find((n) => n.part.id === trail.join("."));
			if (parent) return parent;
		}
		return nodes[0];
	}

	private select(part: Part | undefined): void {
		if (part?.id !== this.selectedId) this.detailTop = 0;
		this.selectedId = part?.id;
		this.follow = true;
	}

	/** Up or down to the closest part of the same depth, else of the closest depth. */
	private moveVertically(by: -1 | 1): void {
		const nodes = this.nodes();
		const at = this.current(nodes);
		if (!at) return;
		const ahead = nodes.filter((n) => (n.row - at.row) * by > 0);
		ahead.sort((a, b) => Math.abs(a.depth - at.depth) - Math.abs(b.depth - at.depth) || Math.abs(a.row - at.row) - Math.abs(b.row - at.row));
		if (ahead[0]) this.select(ahead[0].part);
	}

	private moveTo(end: "first" | "last"): void {
		const nodes = this.nodes();
		this.select((end === "first" ? nodes[0] : nodes[nodes.length - 1])?.part);
	}

	private toggle(part: Part, open?: boolean): void {
		if (part.parts.length === 0) return;
		const fold = open === undefined ? !this.folded.has(part.id) : !open;
		if (fold) this.folded.add(part.id);
		else this.folded.delete(part.id);
		this.follow = true;
	}

	private pan(dx: number, dy: number): void {
		this.view = this.clampView(this.view.x + dx, this.view.y + dy);
		this.follow = false;
	}

	private clampView(x: number, y: number): { x: number; y: number } {
		const { treeWidth, bodyRows } = this.layout;
		return {
			x: Math.max(0, Math.min(x, this.canvas.width - treeWidth)),
			y: Math.max(0, Math.min(y, this.canvas.height - bodyRows)),
		};
	}

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	height(): number {
		return Math.max(10, this.o.rows());
	}

	render(width: number): string[] {
		const t = this.o.theme;
		const workflow = this.o.workflow();
		const inner = Math.max(10, width - 4);
		const narrow = inner < NARROW;
		const bodyRows = this.height() - 2 - 2;
		const nodes = this.nodes();
		const node = this.current(nodes);
		this.selectedId = node?.part.id;
		// The canvas as wide as the tree needs, the details keeping at least DETAIL_MIN.
		const treeWidth = narrow ? inner : Math.max(24, Math.min(this.canvas.width, inner - DIVIDER - DETAIL_MIN));
		const detailWidth = narrow ? inner : inner - treeWidth - DIVIDER;
		this.layout = { bodyTop: 3, bodyRows, treeWidth, narrow };
		const tree = narrow && this.detail ? [] : this.canvasLines(node, treeWidth, bodyRows);
		const details = narrow && !this.detail ? [] : this.detailLines(workflow, node?.part, detailWidth, bodyRows);
		const lines = [this.headLine(workflow, inner, narrow && this.detail ? "" : this.more(treeWidth, bodyRows)), ""];
		for (let r = 0; r < bodyRows; r++) {
			if (narrow) lines.push(this.detail ? details[r] ?? "" : tree[r] ?? "");
			else lines.push(`${pad(tree[r] ?? "", treeWidth)}${t.fg("borderMuted", " │ ")}${details[r] ?? ""}`);
		}
		const title = `${this.review ? "Review the plan · " : ""}Workflow #${workflow.id} · ${workflow.title}`;
		return frame(t, width, t.bold(title), this.hint(narrow), lines.map((l) => pad(l, inner)));
	}

	/** Arrows to where more of the tree lies beyond the view, e.g. "→↓". */
	private more(width: number, height: number): string {
		const { x, y } = this.view;
		return `${x > 0 ? "←" : ""}${x + width < this.canvas.width ? "→" : ""}${y > 0 ? "↑" : ""}${y + height < this.canvas.height ? "↓" : ""}`;
	}

	private headLine(workflow: Workflow, inner: number, more = ""): string {
		const t = this.o.theme;
		if (this.prompt) return truncateToWidth(`${t.fg("accent", `${this.prompt.label}: `)}${this.prompt.value}${t.fg("accent", "▏")}`, inner);
		if (this.message) return truncateToWidth(t.fg(this.message.error ? "error" : "success", this.message.text), inner);
		const bits = [t.fg(STATE_COLOR[workflow.state], workflow.state)];
		if (more) bits.push(t.fg("accent", `more ${more}`));
		bits.push(t.fg("muted", progressLine(workflow)), t.fg("dim", `subagents: ${workflow.model ?? "default model"} · ${workflow.parallel} at once`));
		return truncateToWidth(bits.join(t.fg("dim", " · ")), inner);
	}

	/** The part of the canvas in view, the selected part brought into view first if it moved. */
	private canvasLines(node: CanvasNode | undefined, width: number, height: number): string[] {
		const t = this.o.theme;
		let { x, y } = this.view;
		if (this.follow && node) {
			if (node.x + node.width > x + width) x = node.x + node.width - width;
			if (node.x < x) x = Math.max(0, node.x - 2);
			if (node.row < y) y = node.row;
			if (node.row >= y + height) y = node.row - height + 1;
		}
		this.follow = false;
		this.view = this.clampView(x, y);
		const byRow = new Map<number, CanvasNode[]>();
		for (const n of this.canvas.nodes) byRow.set(n.row, [...(byRow.get(n.row) ?? []), n]);
		const out: string[] = [];
		for (let r = this.view.y; r < Math.min(this.canvas.height, this.view.y + height); r++) {
			const pieces: { x: number; text: string }[] = (this.canvas.pieces[r] ?? []).map((p) => ({
				x: p.x,
				text: p.kind === "root" ? t.bold(t.fg("accent", p.text)) : t.fg("dim", p.text),
			}));
			for (const n of byRow.get(r) ?? []) pieces.push({ x: n.x, text: this.nodeText(n, n.part.id === node?.part.id) });
			pieces.sort((a, b) => a.x - b.x);
			let line = "";
			let column = 0;
			for (const p of pieces) {
				line += " ".repeat(Math.max(0, p.x - column)) + p.text;
				column = Math.max(column, p.x) + visibleWidth(p.text);
			}
			out.push(`${sliceByColumn(line, this.view.x, width, true)}\x1b[0m`);
		}
		return out;
	}

	/** A part's box: its mark and title only. */
	private nodeText(n: CanvasNode, selected: boolean): string {
		const t = this.o.theme;
		const status = statusOf(n.part);
		const label = selected
			? t.bold(t.fg("accent", n.label))
			: status === "skipped"
				? t.fg("dim", t.strikethrough(n.label))
				: t.fg(status === "pending" ? "text" : status === "failed" ? "error" : "muted", n.label);
		const text = `${mark(t, status, this.frame)} ${label}${n.folded ? t.fg("dim", " ▸") : ""}`;
		return selected ? t.bg("selectedBg", text) : text;
	}

	private detailAll(workflow: Workflow, part: Part | undefined, width: number): string[] {
		const t = this.o.theme;
		if (!part) return [];
		const now = this.o.now?.() ?? Date.now();
		const status = statusOf(part);
		const trail = pathTo(workflow, part.id);
		const model = part.model ?? trail.slice(0, -1).reverse().find((p) => p.model)?.model ?? workflow.model;
		const meta = [t.fg(status === "failed" ? "error" : status === "done" ? "success" : status === "running" ? "accent" : "muted", status)];
		if (part.parts.length) meta.push(progressLine(part as unknown as Workflow));
		else {
			meta.push(`model ${model ?? "default"}${part.model ? "" : model ? " (inherited)" : ""}`);
			if (part.attempts) meta.push(`${part.attempts} failed ${part.attempts === 1 ? "try" : "tries"}`);
			if (part.tokens) meta.push(`${formatTokens(part.tokens)} tokens`);
			if (part.startedAt !== undefined) meta.push(formatElapsed((part.endedAt ?? now) - part.startedAt));
		}
		const out = [...wrapTextWithAnsi(t.bold(`${part.id} ${part.title}`), width), ...wrapTextWithAnsi(meta.join(t.fg("dim", " · ")), width)];
		if (trail.length > 1) out.push(truncateToWidth(t.fg("dim", `within ${trail.slice(0, -1).map((p) => `${p.id} ${p.title}`).join(" › ")}`), width));
		if (part.dependsOn.length) out.push(truncateToWidth(t.fg("dim", `after ${part.dependsOn.join(", ")}`), width));
		const section = (label: string, text: string | undefined) => {
			if (!text) return;
			out.push("", t.fg("accent", label), ...this.o.markdown(text, width));
		};
		section("Task", part.detail);
		section("Note", part.note);
		section("Result", part.result);
		if (part.parts.length && !part.detail) out.push("", t.fg("dim", `${part.parts.length} parts; space folds them`));
		return out;
	}

	private detailLines(workflow: Workflow, part: Part | undefined, width: number, rows: number): string[] {
		const all = this.detailAll(workflow, part, width);
		this.detailTop = Math.max(0, Math.min(this.detailTop, all.length - rows));
		const lines = all.slice(this.detailTop, this.detailTop + rows);
		const t = this.o.theme;
		const markLine = (line: string, arrow: string) => `${truncateToWidth(line, width - 2, "", true)}${t.fg("dim", ` ${arrow}`)}`;
		if (this.detailTop > 0 && lines.length > 0) lines[0] = markLine(lines[0], "↑");
		if (this.detailTop + rows < all.length) lines[rows - 1] = markLine(lines[rows - 1] ?? "", "↓");
		return lines;
	}

	private hint(narrow: boolean): string {
		const t = this.o.theme;
		if (this.prompt) return t.fg("dim", "type · enter save · esc cancel");
		const edit = ["e title", "d task", "n new", "i new inside", "x remove", "m model", "+/- at once"];
		const move = ["↑↓←→ select", "space fold", "shift+↑↓←→ or drag pan"];
		const parts = this.review
			? ["a approve", "f feedback", ...move, ...edit, "esc close"]
			: [...move, this.o.workflow().state === "paused" ? "p continue" : "p pause", "c cancel", "r restart", ...edit, "esc close"];
		if (narrow) parts.splice(this.review ? 3 : 1, 0, "⏎ details");
		return t.fg("dim", parts.join(" · "));
	}

	invalidate(): void {}

	// -------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.prompt) this.promptInput(data);
		else {
			this.message = undefined;
			this.keyInput(data);
		}
		this.o.requestRender();
	}

	private ask(label: string, value: string, apply: (value: string) => void): void {
		this.prompt = { label, value, apply };
	}

	private promptInput(data: string): void {
		const prompt = this.prompt!;
		if (matchesKey(data, Key.escape)) this.prompt = undefined;
		else if (matchesKey(data, Key.enter)) {
			this.prompt = undefined;
			prompt.apply(prompt.value);
		} else if (matchesKey(data, Key.backspace)) prompt.value = prompt.value.slice(0, -1);
		else if (matchesKey(data, Key.ctrl("u"))) prompt.value = "";
		else prompt.value += typedText(data);
	}

	private change(fn: (workflow: Workflow, now: number) => void, done?: string): void {
		const error = this.o.apply(fn);
		this.message = error ? { text: error, error: true } : done ? { text: done, error: false } : undefined;
	}

	private keyInput(data: string): void {
		const workflow = this.o.workflow();
		const part = this.current()?.part;
		const page = Math.max(1, this.layout.bodyRows - 2);
		const scrolling = this.layout.narrow && this.detail;
		if (matchesKey(data, Key.escape) || data === "q") {
			if (scrolling) this.detail = false;
			else this.o.close();
		} else if (matchesKey(data, Key.shift("up"))) this.pan(0, -PAN_Y);
		else if (matchesKey(data, Key.shift("down"))) this.pan(0, PAN_Y);
		else if (matchesKey(data, Key.shift("left"))) this.pan(-PAN_X, 0);
		else if (matchesKey(data, Key.shift("right"))) this.pan(PAN_X, 0);
		else if (matchesKey(data, Key.up) || data === "k") {
			if (scrolling) this.detailTop = Math.max(0, this.detailTop - 1);
			else this.moveVertically(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (scrolling) this.detailTop += 1;
			else this.moveVertically(1);
		} else if (matchesKey(data, Key.pageUp)) this.detailTop = Math.max(0, this.detailTop - page);
		else if (matchesKey(data, Key.pageDown)) this.detailTop += page;
		else if (matchesKey(data, Key.home)) this.moveTo("first");
		else if (matchesKey(data, Key.end)) this.moveTo("last");
		else if (matchesKey(data, Key.left) || data === "h") {
			if (part?.id.includes(".")) this.select(pathTo(workflow, part.id).at(-2));
		} else if (matchesKey(data, Key.right) || data === "l") {
			if (part?.parts.length) {
				this.toggle(part, true);
				this.select(part.parts[0]);
			}
		} else if (matchesKey(data, Key.enter) || data === " ") {
			if (this.layout.narrow && !this.detail && (!part?.parts.length || matchesKey(data, Key.enter))) this.detail = true;
			else if (part) this.toggle(part);
		} else if (!part) return;
		else if (data === "e") this.ask("Title", part.title, (v) => this.change((w, now) => editPart(w, part.id, { title: v }, now)));
		else if (data === "d") this.ask("Task", part.detail ?? "", (v) => this.change((w, now) => editPart(w, part.id, { detail: v }, now)));
		else if (data === "n" || data === "i") {
			const parent = data === "i" ? part.id : part.id.split(".").slice(0, -1).join(".") || undefined;
			this.ask(data === "i" ? `New part in ${part.id}` : "New part", "", (v) => {
				if (!v.trim()) return;
				let added: Part | undefined;
				this.change((w, now) => {
					added = addPart(w, parent, v, now);
				});
				if (added) {
					if (parent) this.folded.delete(parent);
					this.select(added);
				}
			});
		} else if (data === "x") this.change((w, now) => removePart(w, part.id, now), `Removed ${part.id}`);
		else if (data === "m") {
			const next = MODEL_CHOICES[(MODEL_CHOICES.indexOf(part.model ?? "") + 1) % MODEL_CHOICES.length];
			this.change((w, now) => editPart(w, part.id, { model: next }, now), `Model of ${part.id}: ${next || "default"}`);
		} else if (data === "M") {
			const next = MODEL_CHOICES[(MODEL_CHOICES.indexOf(workflow.model ?? "") + 1) % MODEL_CHOICES.length];
			this.change((w) => {
				w.model = next || undefined;
				if (w.state !== "review") w.news.push(`The user set the subagents' model to ${next || "the default"}.`);
			}, `Subagents' model: ${next || "default"}`);
		} else if (data === "+" || data === "-") {
			const parallel = clampParallel(workflow.parallel + (data === "+" ? 1 : -1));
			this.change((w) => {
				w.parallel = parallel;
			}, `${parallel} at once`);
		} else if (this.review) {
			if (data === "a") this.o.approve?.();
			else if (data === "f") this.ask("What should change", "", (v) => v.trim() && this.o.reject?.(v.trim()));
		} else if (data === "p") this.o.pause?.(workflow.state !== "paused");
		else if (data === "c") this.change((w, now) => void cancelPart(w, part.id, now), `Cancelled ${part.id}`);
		else if (data === "r") this.change((w, now) => restartPart(w, part.id, now), `${part.id} starts again`);
	}

	/** The part whose box is at a point of the popup, if any. */
	private nodeAt(x: number, y: number): CanvasNode | undefined {
		const column = this.view.x + x;
		const row = this.view.y + y - this.layout.bodyTop;
		return this.canvas.nodes.find((n) => n.row === row && column >= n.x && column < n.x + n.width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { bodyTop, bodyRows, treeWidth, narrow } = this.layout;
		const x = event.x - 2;
		if (this.drag && (event.type === "drag" || event.type === "release")) {
			const { screenX, screenY, x: fromX, y: fromY } = this.drag;
			this.view = this.clampView(fromX - (event.screenX - screenX), fromY - (event.screenY - screenY));
			this.follow = false;
			if (event.type === "release") this.drag = undefined;
			return { handled: true, render: event.type === "drag" };
		}
		const inTree = narrow ? !this.detail : x < treeWidth;
		const inBody = event.y >= bodyTop && event.y < bodyTop + bodyRows;
		if (event.type === "wheel") {
			const by = event.wheelDelta ?? 0;
			if (!inTree) this.detailTop = Math.max(0, this.detailTop + by);
			else if (event.shift) this.pan(by * 4, 0);
			else this.pan(0, by);
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			if (inTree && inBody) {
				this.drag = { screenX: event.screenX, screenY: event.screenY, x: this.view.x, y: this.view.y };
				return { capture: true, render: false };
			}
			return { handled: true, render: false };
		}
		if (event.type === "release") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (inTree && inBody) {
			const node = this.nodeAt(x, event.y);
			if (node) {
				const again = node.part.id === this.selectedId;
				this.select(node.part);
				if (narrow) this.detail = true;
				else if (again || (event.clickCount ?? 1) >= 2) this.toggle(node.part);
			}
		}
		return { handled: true };
	}
}

/** Typed or pasted text for a one-line field: paste markers dropped, line breaks as spaces, other keys (arrows, …) nothing. */
export function typedText(data: string): string {
	const text = data.replace(/\x1b\[20[01]~/g, "");
	if (text.includes("\x1b")) return "";
	return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}

const pad = (line: string, width: number) => {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

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
