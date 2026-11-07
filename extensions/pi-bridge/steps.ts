/**
 * Steps: a stepper an agent shows above the editor for a job of several steps,
 * e.g. putting an app on a phone: build the APK → check the device → install →
 * start. The agent sets the steps (`steps_set`), moves each through pending,
 * running, done, failed or skipped (`steps_update`) and removes them
 * (`steps_clear`); a finished list goes away by itself after a short while.
 *
 *   Install the app · Step 2 of 4
 *   ✓ Build APK ── ⠹ Check device ── ○ Install APK ── ○ Start app
 *     adb devices · 4s
 *
 * Too narrow for one row, the steps stand below each other.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed } from "./watch.ts";

export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Most steps in one list. */
export const MAX_STEPS = 20;
/** How long a finished list stays before it goes away by itself. */
export const LINGER_MS = 10_000;
/** Spinner of the running step. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 80;

export interface Step {
	title: string;
	detail?: string;
	status: StepStatus;
	note?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface StepList {
	title?: string;
	steps: Step[];
	/** When the last open step ended. */
	finishedAt?: number;
}

export interface StepInput {
	title: string;
	detail?: string;
	status?: StepStatus;
	note?: string;
}

export interface StepperOptions {
	/** Called whenever the list changed or went away. */
	onChange?(): void;
	lingerMs?: number;
	now?(): number;
}

const isStatus = (value: unknown): value is StepStatus => STEP_STATUSES.includes(value as StepStatus);
const isOpen = (step: Step) => step.status === "pending" || step.status === "running";
const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export class Stepper {
	private current: StepList | undefined;
	private linger: ReturnType<typeof setTimeout> | undefined;
	private options: StepperOptions;

	constructor(options: StepperOptions = {}) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	get list(): StepList | undefined {
		return this.current;
	}

	/** Shows these steps, replacing the list shown before. Throws on input it cannot show. */
	set(title: unknown, inputs: unknown): StepList {
		if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("`steps` needs at least one step.");
		if (inputs.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps.`);
		const now = this.now();
		const steps = inputs.map((input: Partial<StepInput> | string, i): Step => {
			const raw = typeof input === "string" ? { title: input } : (input ?? {});
			const stepTitle = clean(raw.title);
			if (!stepTitle) throw new Error(`Step ${i + 1} has no title.`);
			if (raw.status !== undefined && !isStatus(raw.status)) throw new Error(`Step ${i + 1}: unknown status ${raw.status}; one of ${STEP_STATUSES.join(", ")}.`);
			const status = raw.status ?? "pending";
			return {
				title: stepTitle,
				detail: clean(raw.detail),
				status,
				note: clean(raw.note),
				startedAt: status === "pending" ? undefined : now,
				endedAt: status === "pending" || status === "running" ? undefined : now,
			};
		});
		this.current = { title: clean(title), steps };
		this.settle();
		return this.current;
	}

	/**
	 * Sets a step's status (and note or detail), the step given by its number
	 * (1-based) or title. Throws when there is no list or no such step.
	 */
	update(which: unknown, status: unknown, extra: { note?: unknown; detail?: unknown } = {}): { index: number; step: Step } {
		const list = this.current;
		if (!list) throw new Error("No steps are shown; set them with `steps_set` first.");
		const index = indexOf(list, which);
		if (index < 0) throw new Error(`No step ${JSON.stringify(which)}; the steps are ${list.steps.map((s, i) => `${i + 1}. ${s.title}`).join(", ")}.`);
		if (status !== undefined && !isStatus(status)) throw new Error(`Unknown status ${status}; one of ${STEP_STATUSES.join(", ")}.`);
		const step = list.steps[index];
		const now = this.now();
		if (status !== undefined && status !== step.status) {
			step.status = status;
			if (status === "pending") step.startedAt = step.endedAt = undefined;
			else if (status === "running") {
				step.startedAt = now;
				step.endedAt = undefined;
			} else {
				step.startedAt ??= now;
				step.endedAt = now;
			}
		}
		if (extra.note !== undefined) step.note = clean(extra.note);
		if (extra.detail !== undefined) step.detail = clean(extra.detail);
		this.settle();
		return { index, step };
	}

	/** Removes the list; false when none was shown. */
	clear(): boolean {
		this.stopLinger();
		if (!this.current) return false;
		this.current = undefined;
		this.options.onChange?.();
		return true;
	}

	/** After a change: a finished list goes away after a while, an open one stays. */
	private settle(): void {
		const list = this.current!;
		this.stopLinger();
		if (list.steps.some(isOpen)) list.finishedAt = undefined;
		else {
			list.finishedAt ??= this.now();
			this.linger = setTimeout(() => this.clear(), this.options.lingerMs ?? LINGER_MS);
			this.linger.unref?.();
		}
		this.options.onChange?.();
	}

	private stopLinger(): void {
		if (this.linger) clearTimeout(this.linger);
		this.linger = undefined;
	}
}

function indexOf(list: StepList, which: unknown): number {
	const number = typeof which === "number" ? which : typeof which === "string" && /^\s*\d+\s*$/.test(which) ? Number(which) : undefined;
	if (number !== undefined) return Number.isInteger(number) && number >= 1 && number <= list.steps.length ? number - 1 : -1;
	const title = clean(which)?.toLowerCase();
	return title ? list.steps.findIndex((s) => s.title.toLowerCase() === title) : -1;
}

/** The step the list is at: the first running, else the first failed or open one, else the last. */
export function currentIndex(list: StepList): number {
	const at = (status: StepStatus) => list.steps.findIndex((s) => s.status === status);
	for (const status of ["running", "failed", "pending"] as const) {
		const index = at(status);
		if (index >= 0) return index;
	}
	return list.steps.length - 1;
}

/** "Step 2 of 4", "Step 3 of 4 failed", "4 of 4 done". */
export function progressText(list: StepList): string {
	const n = list.steps.length;
	const failed = list.steps.findIndex((s) => s.status === "failed");
	if (!list.steps.some(isOpen)) {
		if (failed >= 0) return `Step ${failed + 1} of ${n} failed`;
		return `${list.steps.filter((s) => s.status === "done").length} of ${n} done`;
	}
	return `Step ${currentIndex(list) + 1} of ${n}`;
}

/** What the agent is told after a change. */
export function summary(list: StepList): string {
	const lines = list.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.status}${s.note ? ` (${s.note})` : ""}`);
	const end = list.finishedAt ? " Finished; it goes away by itself shortly." : "";
	return `${list.title ? `${list.title} · ` : ""}${progressText(list)}.${end}\n${lines.join("\n")}`;
}

/** What the stepper needs of pi's theme. */
export interface StepColors {
	fg(color: "accent" | "dim" | "muted" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

function mark(theme: StepColors, step: Step, frame: number): string {
	switch (step.status) {
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

function label(theme: StepColors, step: Step): string {
	switch (step.status) {
		case "done":
			return theme.fg("muted", step.title);
		case "running":
			return theme.bold(theme.fg("accent", step.title));
		case "failed":
			return theme.fg("error", step.title);
		case "skipped":
			return theme.fg("dim", theme.strikethrough(step.title));
		default:
			return theme.fg("dim", step.title);
	}
}

/** Detail, note and run time of a step, e.g. "adb devices · 4s". */
function aside(step: Step, now: number): string {
	const parts = [step.detail, step.note];
	if (step.status === "running" && step.startedAt !== undefined) parts.push(formatElapsed(now - step.startedAt));
	return parts.filter(Boolean).join(" · ");
}

/** The lines above the editor: header, the steps in a row (or below each other), the current step's detail. */
export function stepLines(theme: StepColors, list: StepList, width: number, now: number, frame = 0): string[] {
	const failed = list.steps.some((s) => s.status === "failed");
	const finished = !list.steps.some(isOpen);
	const progressColor = finished ? (failed ? "error" : "success") : "dim";
	const header = `${list.title ? `${theme.bold(theme.fg("text", list.title))}${theme.fg("dim", " · ")}` : ""}${theme.fg(progressColor, progressText(list))}`;
	const lines = [truncateToWidth(header, width)];

	const row = list.steps.map((s) => `${mark(theme, s, frame)} ${label(theme, s)}`).join(theme.fg("dim", " ── "));
	if (visibleWidth(row) <= width) {
		lines.push(row);
		const step = list.steps[currentIndex(list)];
		const extra = step && (step.status === "running" || step.status === "failed") ? aside(step, now) : "";
		if (extra) lines.push(truncateToWidth(theme.fg(step.status === "failed" ? "error" : "dim", `  ${extra}`), width));
		return lines;
	}
	for (const step of list.steps) {
		const extra = step.status === "pending" || step.status === "skipped" ? step.detail : aside(step, now);
		lines.push(truncateToWidth(`${mark(theme, step, frame)} ${label(theme, step)}${extra ? theme.fg(step.status === "failed" ? "error" : "dim", ` · ${extra}`) : ""}`, width));
	}
	return lines;
}
