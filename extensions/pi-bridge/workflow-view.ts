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
 * The popup (WorkflowBrowser):
 *
 *   ╭─ Workflow #3 · Build a car model ───────────────────────────────╮
 *   │ running · 12 of 30 done · 3 running · 245.1k tokens · 3 at once │
 *   │                                                                  │
 *   │ ▾ ✓ 1 Wheels 5/5          │ 2.4 Doors                            │
 *   │ ▾ ⠹ 2 Body 3/8            │ running · model sonnet · 1m 12s      │
 *   │   ✓ 2.1 Frame             │ within 2 Body                        │
 *   │ › ⠹ 2.4 Doors             │ …result as Markdown                  │
 *   ╰─ ↑↓ select · ←→ fold · e edit · n new · p pause · esc close ────╯
 *
 * In review the keys approve (a) or send the plan back with feedback (f);
 * while it runs they pause and continue (p), cancel (c) and restart (r)
 * parts. Both can edit titles (e) and details (d), add parts next to (n) or
 * inside (i) the selected one, remove (x) parts that have not started and
 * choose the subagents' model (m for the part, M for the workflow) and how many
 * run at once (+/-).
 */

import { Key, matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

interface Row {
	part: Part;
	depth: number;
}

interface Prompt {
	label: string;
	value: string;
	apply(value: string): void;
}

/** Columns between the tree and the details: " │ ". */
const DIVIDER = 3;
/** Below this inner width the popup shows the tree only; enter shows the details. */
export const NARROW = 70;

export class WorkflowBrowser {
	private selectedId: string | undefined;
	private folded = new Set<string>();
	private treeTop = 0;
	private detailTop = 0;
	private prompt: Prompt | undefined;
	private message: { text: string; error: boolean } | undefined;
	private frame = 0;
	/** Narrow mode: showing the details instead of the tree. */
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

	private rows(): Row[] {
		const rows: Row[] = [];
		const walk = (parts: Part[], depth: number) => {
			for (const part of parts) {
				rows.push({ part, depth });
				if (!this.folded.has(part.id)) walk(part.parts, depth + 1);
			}
		};
		walk(this.o.workflow().parts, 0);
		return rows;
	}

	private current(rows = this.rows()): Row | undefined {
		const found = rows.find((r) => r.part.id === this.selectedId);
		if (found) return found;
		// A removed or folded part: its closest visible parent, else the first row.
		const trail = this.selectedId?.split(".") ?? [];
		while (trail.length) {
			trail.pop();
			const parent = rows.find((r) => r.part.id === trail.join("."));
			if (parent) return parent;
		}
		return rows[0];
	}

	private select(part: Part | undefined): void {
		if (part?.id !== this.selectedId) this.detailTop = 0;
		this.selectedId = part?.id;
	}

	private move(by: number): void {
		const rows = this.rows();
		const at = Math.max(0, rows.indexOf(this.current(rows)!));
		this.select(rows[Math.max(0, Math.min(rows.length - 1, at + by))]?.part);
	}

	private toggle(part: Part, open?: boolean): void {
		if (part.parts.length === 0) return;
		const fold = open === undefined ? !this.folded.has(part.id) : !open;
		if (fold) this.folded.add(part.id);
		else this.folded.delete(part.id);
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
		const rows = this.rows();
		const row = this.current(rows);
		this.selectedId = row?.part.id;
		const treeWidth = narrow ? inner : Math.min(60, Math.max(28, Math.floor(inner * 0.45)));
		const detailWidth = narrow ? inner : inner - treeWidth - DIVIDER;
		const tree = narrow && this.detail ? [] : this.treeLines(rows, row, treeWidth, bodyRows);
		const details = narrow && !this.detail ? [] : this.detailLines(workflow, row?.part, detailWidth, bodyRows);
		const lines = [this.headLine(workflow, inner), ""];
		for (let r = 0; r < bodyRows; r++) {
			if (narrow) lines.push(this.detail ? details[r] ?? "" : tree[r] ?? "");
			else lines.push(`${pad(tree[r] ?? "", treeWidth)}${t.fg("borderMuted", " │ ")}${details[r] ?? ""}`);
		}
		this.layout = { bodyTop: 3, bodyRows, treeWidth, narrow };
		const title = `${this.review ? "Review the plan · " : ""}Workflow #${workflow.id} · ${workflow.title}`;
		return frame(t, width, t.bold(title), this.hint(narrow), lines.map((l) => pad(l, inner)));
	}

	private headLine(workflow: Workflow, inner: number): string {
		const t = this.o.theme;
		if (this.prompt) return truncateToWidth(`${t.fg("accent", `${this.prompt.label}: `)}${this.prompt.value}${t.fg("accent", "▏")}`, inner);
		if (this.message) return truncateToWidth(t.fg(this.message.error ? "error" : "success", this.message.text), inner);
		const bits = [t.fg(STATE_COLOR[workflow.state], workflow.state), t.fg("muted", progressLine(workflow))];
		bits.push(t.fg("dim", `subagents: ${workflow.model ?? "default model"} · ${workflow.parallel} at once`));
		return truncateToWidth(bits.join(t.fg("dim", " · ")), inner);
	}

	private treeLines(rows: Row[], row: Row | undefined, width: number, height: number): string[] {
		const t = this.o.theme;
		const at = row ? rows.indexOf(row) : 0;
		this.treeTop = Math.max(0, Math.min(this.treeTop, rows.length - height));
		if (at < this.treeTop) this.treeTop = at;
		if (at >= this.treeTop + height) this.treeTop = at - height + 1;
		return rows.slice(this.treeTop, this.treeTop + height).map(({ part, depth }) => {
			const selected = part.id === row?.part.id;
			const status = statusOf(part);
			const fold = part.parts.length ? (this.folded.has(part.id) ? "▸ " : "▾ ") : "  ";
			const p = part.parts.length ? progressOf(part) : undefined;
			const count = p ? t.fg("dim", ` ${p.done}/${p.total}`) : "";
			const tokens = !p && part.tokens ? t.fg("dim", ` ${formatTokens(part.tokens)}`) : "";
			const name = `${part.id} ${part.title}`;
			const label = selected
				? t.bold(t.fg("accent", name))
				: status === "skipped"
					? t.fg("dim", t.strikethrough(name))
					: t.fg(status === "pending" ? "text" : status === "failed" ? "error" : "muted", name);
			const line = truncateToWidth(`${"  ".repeat(depth)}${t.fg("dim", fold)}${mark(t, status, this.frame)} ${label}${count}${tokens}`, width);
			return selected ? t.bg("selectedBg", pad(line, width)) : line;
		});
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
		if (part.parts.length && !part.detail) out.push("", t.fg("dim", `${part.parts.length} parts; enter folds them`));
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
		const parts = this.review
			? ["a approve", "f feedback", "↑↓ select", "←→ fold", ...edit, "esc close"]
			: ["↑↓ select", "←→ fold", this.o.workflow().state === "paused" ? "p continue" : "p pause", "c cancel", "r restart", ...edit, "esc close"];
		if (narrow) parts.splice(2, 0, "⏎ details");
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
		const row = this.current();
		const part = row?.part;
		const page = Math.max(1, this.layout.bodyRows - 2);
		const scrolling = this.layout.narrow && this.detail;
		if (matchesKey(data, Key.escape) || data === "q") {
			if (scrolling) this.detail = false;
			else this.o.close();
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (scrolling) this.detailTop = Math.max(0, this.detailTop - 1);
			else this.move(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (scrolling) this.detailTop += 1;
			else this.move(1);
		} else if (matchesKey(data, Key.shift("up"))) this.detailTop = Math.max(0, this.detailTop - 1);
		else if (matchesKey(data, Key.shift("down"))) this.detailTop += 1;
		else if (matchesKey(data, Key.pageUp)) this.detailTop = Math.max(0, this.detailTop - page);
		else if (matchesKey(data, Key.pageDown)) this.detailTop += page;
		else if (matchesKey(data, Key.home)) this.move(-Infinity);
		else if (matchesKey(data, Key.end)) this.move(Infinity);
		else if (matchesKey(data, Key.left) || data === "h") {
			if (part && part.parts.length && !this.folded.has(part.id)) this.toggle(part, false);
			else if (part?.id.includes(".")) this.select(pathTo(workflow, part.id).at(-2));
		} else if (matchesKey(data, Key.right) || data === "l") {
			if (part) this.toggle(part, true);
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { bodyTop, bodyRows, treeWidth, narrow } = this.layout;
		const x = event.x - 2;
		const inTree = narrow ? !this.detail : x < treeWidth;
		if (event.type === "wheel") {
			const by = Math.sign(event.wheelDelta ?? 0);
			if (inTree) this.move(by);
			else this.detailTop = Math.max(0, this.detailTop + (event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press" || event.type === "release") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		const r = event.y - bodyTop;
		if (r >= 0 && r < bodyRows && inTree) {
			const row = this.rows()[this.treeTop + r];
			if (row) {
				const again = row.part.id === this.selectedId;
				this.select(row.part);
				if (narrow) this.detail = true;
				else if (again || (event.clickCount ?? 1) >= 2) this.toggle(row.part);
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
