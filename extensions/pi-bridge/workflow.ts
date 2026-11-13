/**
 * Workflows: a big task planned as a tree of parts, the small parts (the
 * leaves) done one by one by subagents.
 *
 *   Build a car model                       (the workflow)
 *   ├ 1 Wheels                              (a big part)
 *   │ ├ 1.1 Screws                          (a small part: one subagent)
 *   │ └ 1.2 Rubber
 *   └ 2 Body  (depends on 1)
 *     └ 2.1 …
 *
 * The agent proposes the tree (`workflow_plan`), the user reviews and edits it
 * and approves it. Then pi hands out the parts that can start now
 * (`workflow_next`: pending leaves whose dependencies are done, at most
 * `parallel` at a time) and the agent reports how each ended
 * (`workflow_update`). A part that fails is handed out once more; failing again,
 * the user decides. The user can pause, edit the tree, cancel or restart parts
 * at any time; what changed reaches the agent with its next call (`news`).
 *
 * Ids are paths of positions ("1.2" is the second part of the first part) and
 * never change: a removed part leaves a gap, an added one takes the next number.
 *
 * Every workflow is saved as JSON in a folder (~/.pi/agent/workflows), so one
 * can be continued after pi was closed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PART_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

/** review: waiting for the user to approve the plan; stopped: ended without finishing. */
export const WORKFLOW_STATES = ["review", "running", "paused", "done", "stopped"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** How often a small part may fail before the user is asked. */
export const MAX_ATTEMPTS = 2;
/** Most small parts in one workflow. */
export const MAX_LEAVES = 200;
/** Deepest level of the tree. */
export const MAX_DEPTH = 6;
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 10;
/** Model choices the popup cycles through; "" is the default (the workflow's, else the agent's own). */
export const MODEL_CHOICES = ["", "haiku", "sonnet", "opus"];
/** Longest result kept per part. */
const MAX_RESULT = 4000;

export interface Part {
	/** Path of positions, e.g. "1.2"; never changes. */
	id: string;
	title: string;
	/** What to do, for the subagent. */
	detail?: string;
	/** Of a small part; a big part's status comes from its parts (statusOf). */
	status: PartStatus;
	/** Parts (any level) that must be done before this one starts. */
	dependsOn: string[];
	/** Model for its subagent(s); unset takes the workflow's. */
	model?: string;
	/** Times it was handed out and failed. */
	attempts: number;
	/** What its subagent reported. */
	result?: string;
	/** Short note, e.g. why it failed or the user's hint for a new try. */
	note?: string;
	/** Tokens its subagent used (all attempts). */
	tokens?: number;
	startedAt?: number;
	endedAt?: number;
	parts: Part[];
}

export interface Workflow {
	id: number;
	title: string;
	/** The whole task in the user's words. */
	goal?: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	state: WorkflowState;
	/** Default model of the subagents; unset is the agent's own choice. */
	model?: string;
	/** Most small parts running at once. */
	parallel: number;
	parts: Part[];
	/** What the user changed since the agent last asked; told with its next call. */
	news: string[];
	/** Small parts that failed MAX_ATTEMPTS times and wait for the user's decision. */
	asking?: string[];
}

/** A part as the agent writes it in `workflow_plan`. */
export interface PartInput {
	title?: unknown;
	detail?: unknown;
	model?: unknown;
	dependsOn?: unknown;
	parts?: unknown;
}

const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const isStatus = (value: unknown): value is PartStatus => PART_STATUSES.includes(value as PartStatus);
const ids = (value: unknown): string[] =>
	(Array.isArray(value) ? value : typeof value === "string" || typeof value === "number" ? [value] : [])
		.map((v) => String(v).trim())
		.filter(Boolean);

// =============================================================================
// Building and walking the tree
// =============================================================================

/** A workflow from the agent's plan. Throws on a plan it cannot run. */
export function buildWorkflow(
	input: { title?: unknown; goal?: unknown; model?: unknown; parallel?: unknown; parts?: unknown },
	meta: { id: number; cwd: string; now: number },
): Workflow {
	const title = clean(input.title);
	if (!title) throw new Error("The workflow needs a `title`.");
	const build = (list: unknown, prefix: string, depth: number): Part[] => {
		if (!Array.isArray(list)) return [];
		if (depth > MAX_DEPTH) throw new Error(`At most ${MAX_DEPTH} levels.`);
		return list.map((raw: PartInput | string, i): Part => {
			const item: PartInput = typeof raw === "string" ? { title: raw } : (raw ?? {});
			const id = prefix ? `${prefix}.${i + 1}` : String(i + 1);
			const partTitle = clean(item.title);
			if (!partTitle) throw new Error(`Part ${id} has no title.`);
			return {
				id,
				title: partTitle,
				detail: clean(item.detail),
				status: "pending",
				dependsOn: ids(item.dependsOn),
				model: clean(item.model),
				attempts: 0,
				parts: build(item.parts, id, depth + 1),
			};
		});
	};
	const parts = build(input.parts, "", 1);
	if (parts.length === 0) throw new Error("The workflow needs `parts`.");
	const workflow: Workflow = {
		id: meta.id,
		title,
		goal: clean(input.goal),
		cwd: meta.cwd,
		createdAt: meta.now,
		updatedAt: meta.now,
		state: "review",
		model: clean(input.model),
		parallel: clampParallel(input.parallel),
		parts,
		news: [],
	};
	if (leaves(workflow).length > MAX_LEAVES) throw new Error(`At most ${MAX_LEAVES} small parts.`);
	const problem = checkDependencies(workflow);
	if (problem) throw new Error(problem);
	return workflow;
}

export function clampParallel(value: unknown): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 1 ? Math.min(MAX_PARALLEL, n) : DEFAULT_PARALLEL;
}

/** Every part, depth first, in order. */
export function allParts(parts: Part[]): Part[] {
	return parts.flatMap((p) => [p, ...allParts(p.parts)]);
}

/** The small parts (no parts of their own), in order. */
export function leaves(workflow: Workflow | Part): Part[] {
	return allParts(workflow.parts).filter((p) => p.parts.length === 0);
}

const leavesOf = (part: Part) => (part.parts.length === 0 ? [part] : leaves(part));

export function findPart(workflow: Workflow, id: unknown): Part | undefined {
	const wanted = String(id ?? "").trim().replace(/^#/, "");
	return allParts(workflow.parts).find((p) => p.id === wanted);
}

/** The parts from the top down to (and with) this one. */
export function pathTo(workflow: Workflow, id: string): Part[] {
	const walk = (parts: Part[], trail: Part[]): Part[] | undefined => {
		for (const part of parts) {
			if (part.id === id) return [...trail, part];
			const found = walk(part.parts, [...trail, part]);
			if (found) return found;
		}
		return undefined;
	};
	return walk(workflow.parts, []) ?? [];
}

/** Big parts take their status from their small parts. */
export function statusOf(part: Part): PartStatus {
	if (part.parts.length === 0) return part.status;
	const statuses = leavesOf(part).map((p) => p.status);
	if (statuses.some((s) => s === "running")) return "running";
	if (statuses.some((s) => s === "failed")) return "failed";
	if (statuses.every((s) => s === "skipped")) return "skipped";
	if (statuses.every((s) => s === "done" || s === "skipped")) return "done";
	return "pending";
}

export const isSettled = (status: PartStatus) => status === "done" || status === "skipped";

/** Tokens of a part and everything below it. */
export function tokensOf(part: Part | Workflow): number {
	return leaves(part as Workflow).reduce((sum, p) => sum + (p.tokens ?? 0), 0);
}

export interface Progress {
	total: number;
	done: number;
	running: number;
	failed: number;
	skipped: number;
	tokens: number;
}

export function progressOf(workflow: Workflow | Part): Progress {
	const all = leaves(workflow as Workflow);
	const count = (status: PartStatus) => all.filter((p) => p.status === status).length;
	return { total: all.length, done: count("done"), running: count("running"), failed: count("failed"), skipped: count("skipped"), tokens: tokensOf(workflow) };
}

/** Problems with the dependencies: unknown parts, a part that waits for itself or a part above or below it, cycles. */
export function checkDependencies(workflow: Workflow): string | undefined {
	const parts = allParts(workflow.parts);
	const byId = new Map(parts.map((p) => [p.id, p]));
	for (const part of parts) {
		for (const dep of part.dependsOn) {
			if (!byId.has(dep)) return `Part ${part.id} depends on ${dep}, which does not exist; ids are positions like 1, 1.2, 2.1.3.`;
			if (dep === part.id || dep.startsWith(`${part.id}.`) || part.id.startsWith(`${dep}.`)) return `Part ${part.id} cannot depend on ${dep}: it is the part itself or a part above or below it.`;
		}
	}
	// Each small part waits for the small parts its own and its big parts' dependencies stand for.
	const waits = new Map(leaves(workflow).map((leaf) => [leaf.id, waitsFor(workflow, leaf).map((p) => p.id)]));
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string): string | undefined => {
		if (state.get(id) === "done") return undefined;
		if (state.get(id) === "visiting") return id;
		state.set(id, "visiting");
		for (const next of waits.get(id) ?? []) {
			const loop = visit(next);
			if (loop) return loop;
		}
		state.set(id, "done");
		return undefined;
	};
	for (const id of waits.keys()) {
		const loop = visit(id);
		if (loop) return `The dependencies go in a circle (through part ${loop}).`;
	}
	return undefined;
}

/** The small parts a small part waits for: through its own dependencies and those of the big parts above it. */
export function waitsFor(workflow: Workflow, leaf: Part): Part[] {
	const deps = pathTo(workflow, leaf.id).flatMap((p) => p.dependsOn);
	const found = new Map<string, Part>();
	for (const dep of deps) {
		const part = findPart(workflow, dep);
		if (part) for (const l of leavesOf(part)) found.set(l.id, l);
	}
	return [...found.values()];
}

/** Small parts that can start now: pending and all they wait for done (or skipped). */
export function readyParts(workflow: Workflow): Part[] {
	return leaves(workflow).filter((leaf) => leaf.status === "pending" && waitsFor(workflow, leaf).every((p) => isSettled(p.status)));
}

// =============================================================================
// What the agent does: start, next, update
// =============================================================================

export type NextResult =
	| { kind: "start"; parts: Part[] }
	| { kind: "wait"; running: Part[] }
	| { kind: "paused" }
	| { kind: "asking"; parts: Part[] }
	| { kind: "blocked"; parts: Part[] }
	| { kind: "done" }
	| { kind: "stopped" }
	| { kind: "review" };

/** The parts to start now (marked running), or why there are none. */
export function nextParts(workflow: Workflow, now: number): NextResult {
	if (workflow.state === "review") return { kind: "review" };
	if (workflow.state === "stopped") return { kind: "stopped" };
	if (workflow.state === "paused") return { kind: "paused" };
	const all = leaves(workflow);
	const running = all.filter((p) => p.status === "running");
	const free = Math.max(0, workflow.parallel - running.length);
	const ready = readyParts(workflow).slice(0, free);
	for (const part of ready) {
		part.status = "running";
		part.startedAt = now;
		part.endedAt = undefined;
	}
	if (ready.length > 0) {
		workflow.updatedAt = now;
		return { kind: "start", parts: ready };
	}
	if (running.length > 0) return { kind: "wait", running };
	const asking = all.filter((p) => workflow.asking?.includes(p.id));
	if (asking.length > 0) return { kind: "asking", parts: asking };
	if (all.every((p) => isSettled(p.status))) {
		finish(workflow, now);
		return { kind: "done" };
	}
	return { kind: "blocked", parts: all.filter((p) => p.status === "failed") };
}

function finish(workflow: Workflow, now: number): void {
	if (workflow.state !== "done") {
		workflow.state = "done";
		workflow.updatedAt = now;
	}
}

export type UpdateOutcome = "ok" | "retry" | "ask" | "ignored";

/**
 * How a small part ended (or that it runs or should start again). A part that
 * fails is handed out once more; failing MAX_ATTEMPTS times it waits for the
 * user (`ask`). A part the user cancelled meanwhile keeps its status (`ignored`).
 */
export function updatePart(
	workflow: Workflow,
	id: unknown,
	status: unknown,
	extra: { result?: unknown; tokens?: unknown; note?: unknown },
	now: number,
): { part: Part; outcome: UpdateOutcome } {
	const part = findPart(workflow, id);
	if (!part) throw new Error(`No part ${JSON.stringify(id)} in workflow #${workflow.id}.`);
	if (part.parts.length > 0) throw new Error(`Part ${part.id} is a big part; report its small parts (${leavesOf(part).map((p) => p.id).join(", ")}).`);
	if (status !== undefined && !isStatus(status)) throw new Error(`Unknown status ${status}; one of ${PART_STATUSES.join(", ")}.`);
	const tokens = Math.floor(Number(extra.tokens));
	if (Number.isFinite(tokens) && tokens > 0) part.tokens = (part.tokens ?? 0) + tokens;
	if (extra.result !== undefined) part.result = clean(extra.result)?.slice(0, MAX_RESULT);
	if (extra.note !== undefined) part.note = clean(extra.note);
	workflow.updatedAt = now;
	// Cancelled or removed by the user while it ran: what the agent reports does not change that.
	if (part.status === "skipped" && status !== undefined && status !== "skipped") return { part, outcome: "ignored" };
	if (status === undefined || status === part.status) return { part, outcome: "ok" };
	if (status === "failed") {
		part.attempts += 1;
		if (part.attempts < MAX_ATTEMPTS) {
			part.status = "pending";
			part.endedAt = now;
			return { part, outcome: "retry" };
		}
		part.status = "failed";
		part.endedAt = now;
		workflow.asking = [...new Set([...(workflow.asking ?? []), part.id])];
		return { part, outcome: "ask" };
	}
	part.status = status;
	if (status === "running") {
		part.startedAt = now;
		part.endedAt = undefined;
	} else if (status === "pending") part.endedAt = undefined;
	else {
		part.startedAt ??= now;
		part.endedAt = now;
	}
	return { part, outcome: "ok" };
}

export type FailureChoice = "retry" | "skip" | "pause";

/** The user's decision on a part that failed MAX_ATTEMPTS times; a hint goes to the next try. */
export function decideFailure(workflow: Workflow, id: string, choice: FailureChoice, hint: string | undefined, now: number): string {
	const part = findPart(workflow, id);
	workflow.asking = (workflow.asking ?? []).filter((a) => a !== id);
	if (!part) return `Part ${id} no longer exists.`;
	workflow.updatedAt = now;
	if (choice === "skip") {
		part.status = "skipped";
		return `The user skipped part ${id} "${part.title}" after it failed.`;
	}
	part.status = "pending";
	part.attempts = MAX_ATTEMPTS - 1;
	if (hint) part.note = hint;
	if (choice === "pause") {
		workflow.state = "paused";
		return `The user paused the workflow after part ${id} "${part.title}" failed; it starts again when they continue${hint ? `. Their hint for it: ${hint}` : ""}.`;
	}
	return `The user wants part ${id} "${part.title}" tried again${hint ? ` with this hint: ${hint}` : ""}.`;
}

// =============================================================================
// What the user does in the popup
// =============================================================================

const note = (workflow: Workflow, text: string) => {
	if (workflow.state !== "review") workflow.news.push(text);
};

/** Adds a part at the end of `parentId` (or at the top); returns it. */
export function addPart(workflow: Workflow, parentId: string | undefined, title: string, now: number): Part {
	const parent = parentId ? findPart(workflow, parentId) : undefined;
	if (parentId && !parent) throw new Error(`No part ${parentId}.`);
	if (parent && parent.parts.length === 0 && parent.status !== "pending") throw new Error(`Part ${parent.id} has already started; add the new part next to it instead.`);
	const siblings = parent ? parent.parts : workflow.parts;
	const last = Math.max(0, ...siblings.map((p) => Number(p.id.split(".").pop())));
	const id = parent ? `${parent.id}.${last + 1}` : String(last + 1);
	const part: Part = { id, title: title.trim(), status: "pending", dependsOn: [], attempts: 0, parts: [] };
	// A small part that gets parts becomes a big part; what it waited for, they wait for.
	siblings.push(part);
	workflow.updatedAt = now;
	if (workflow.state === "done") workflow.state = "running";
	note(workflow, `The user added part ${id} "${part.title}"${parent ? ` to ${parent.id} "${parent.title}"` : ""}.`);
	return part;
}

/** Changes a part's title, detail or model. */
export function editPart(workflow: Workflow, id: string, change: { title?: string; detail?: string; model?: string }, now: number): Part {
	const part = findPart(workflow, id);
	if (!part) throw new Error(`No part ${id}.`);
	const said: string[] = [];
	if (change.title !== undefined && clean(change.title) && clean(change.title) !== part.title) {
		said.push(`title "${clean(change.title)}" (was "${part.title}")`);
		part.title = clean(change.title)!;
	}
	if (change.detail !== undefined && clean(change.detail) !== part.detail) {
		part.detail = clean(change.detail);
		said.push(part.detail ? `detail "${part.detail}"` : "no detail");
	}
	if (change.model !== undefined && (clean(change.model) ?? undefined) !== part.model) {
		part.model = clean(change.model);
		said.push(`model ${part.model ?? "default"}`);
	}
	if (said.length > 0) {
		workflow.updatedAt = now;
		note(workflow, `The user changed part ${id}: ${said.join(", ")}.`);
	}
	return part;
}

/** Removes a part with everything below it; only while none of it has started (else cancel it). */
export function removePart(workflow: Workflow, id: string, now: number): void {
	const trail = pathTo(workflow, id);
	const part = trail.at(-1);
	if (!part) throw new Error(`No part ${id}.`);
	if (leavesOf(part).some((p) => p.status !== "pending" || p.attempts > 0)) throw new Error(`Part ${id} has started; cancel it instead.`);
	const siblings = trail.length > 1 ? trail[trail.length - 2].parts : workflow.parts;
	if (trail.length === 1 && workflow.parts.length === 1) throw new Error("The last part cannot be removed.");
	siblings.splice(siblings.indexOf(part), 1);
	for (const p of allParts(workflow.parts)) p.dependsOn = p.dependsOn.filter((d) => d !== id && !d.startsWith(`${id}.`));
	workflow.asking = workflow.asking?.filter((a) => a !== id && !a.startsWith(`${id}.`));
	workflow.updatedAt = now;
	note(workflow, `The user removed part ${id} "${part.title}"${part.parts.length ? " and its parts" : ""}.`);
}

/** Skips a part's open small parts; running ones should have their subagents stopped. */
export function cancelPart(workflow: Workflow, id: string, now: number): Part[] {
	const part = findPart(workflow, id);
	if (!part) throw new Error(`No part ${id}.`);
	const open = leavesOf(part).filter((p) => p.status === "pending" || p.status === "running" || p.status === "failed");
	const running = open.filter((p) => p.status === "running");
	for (const p of open) {
		p.status = "skipped";
		p.endedAt = now;
	}
	workflow.asking = workflow.asking?.filter((a) => !open.some((p) => p.id === a));
	if (open.length > 0) {
		workflow.updatedAt = now;
		const stop = running.length ? ` Stop the subagents still working on ${running.map((p) => p.id).join(", ")} and ignore their results.` : "";
		note(workflow, `The user cancelled part ${id} "${part.title}".${stop}`);
	}
	return running;
}

/** Hands a part (with everything below it) out again from the start. */
export function restartPart(workflow: Workflow, id: string, now: number): void {
	const part = findPart(workflow, id);
	if (!part) throw new Error(`No part ${id}.`);
	const again = leavesOf(part).filter((p) => p.status !== "pending" || p.attempts > 0);
	const running = again.filter((p) => p.status === "running");
	for (const p of again) {
		p.status = "pending";
		p.attempts = 0;
		p.startedAt = p.endedAt = undefined;
		p.result = undefined;
	}
	workflow.asking = workflow.asking?.filter((a) => !again.some((p) => p.id === a));
	if (again.length > 0) {
		workflow.updatedAt = now;
		if (workflow.state === "done" || workflow.state === "stopped") workflow.state = "running";
		const stop = running.length ? ` Stop the subagents still working on ${running.map((p) => p.id).join(", ")} first.` : "";
		note(workflow, `The user wants part ${id} "${part.title}" done again from the start.${stop}`);
	}
}

/** Pauses or continues; false when nothing changed. */
export function setPaused(workflow: Workflow, paused: boolean, now: number): boolean {
	if (paused ? workflow.state !== "running" : workflow.state !== "paused" && workflow.state !== "stopped") return false;
	workflow.state = paused ? "paused" : "running";
	workflow.updatedAt = now;
	return true;
}

/** Takes what the user changed since the agent last asked. */
export function takeNews(workflow: Workflow): string[] {
	const news = workflow.news;
	workflow.news = [];
	return news;
}

/**
 * After pi started again: parts still marked running may have lost their
 * subagent; the workflow waits (paused) until the user continues it.
 */
export function afterRestart(workflow: Workflow, now: number): void {
	if (workflow.state !== "running") return;
	workflow.state = "paused";
	workflow.updatedAt = now;
	const running = leaves(workflow).filter((p) => p.status === "running");
	if (running.length > 0)
		workflow.news.push(
			`pi was restarted while parts ${running.map((p) => p.id).join(", ")} were running. Report each whose subagent no longer runs as pending (workflow_update) so it is handed out again, or done if its work is complete.`,
		);
}

// =============================================================================
// Text for the agent
// =============================================================================

/** The tree as text: one line per part with id, status, dependencies and model. */
export function describeTree(workflow: Workflow, options: { results?: boolean } = {}): string {
	const lines: string[] = [];
	const walk = (parts: Part[], depth: number) => {
		for (const part of parts) {
			const status = statusOf(part);
			const bits: string[] = [status];
			if (part.parts.length) {
				const p = progressOf(part);
				bits.push(`${p.done}/${p.total} done`);
			}
			if (part.dependsOn.length) bits.push(`after ${part.dependsOn.join(", ")}`);
			if (part.model) bits.push(`model ${part.model}`);
			if (part.tokens) bits.push(`${part.tokens} tokens`);
			lines.push(`${"  ".repeat(depth)}${part.id} ${part.title} [${bits.join(", ")}]`);
			if (part.detail) lines.push(`${"  ".repeat(depth + 1)}${part.detail}`);
			if (part.note) lines.push(`${"  ".repeat(depth + 1)}note: ${part.note}`);
			if (options.results && part.result) lines.push(`${"  ".repeat(depth + 1)}result: ${part.result.replace(/\s+/g, " ").slice(0, 300)}`);
			walk(part.parts, depth + 1);
		}
	};
	walk(workflow.parts, 0);
	const p = progressOf(workflow);
	const head = `Workflow #${workflow.id} "${workflow.title}" · ${workflow.state} · ${p.done} of ${p.total} small parts done${p.running ? `, ${p.running} running` : ""}${p.failed ? `, ${p.failed} failed` : ""}${p.tokens ? ` · ${p.tokens} tokens` : ""}${workflow.model ? ` · subagent model ${workflow.model}` : ""} · up to ${workflow.parallel} at once`;
	return [head, ...lines].join("\n");
}

/** What a subagent needs to know about its part. */
export function partBrief(workflow: Workflow, part: Part): string {
	const trail = pathTo(workflow, part.id);
	const where = trail.slice(0, -1).map((p) => `${p.id} ${p.title}`);
	const model = part.model ?? trail.slice(0, -1).reverse().find((p) => p.model)?.model ?? workflow.model;
	const lines = [`${part.id} ${part.title}`];
	lines.push(`  subagent description: "W${workflow.id} ${part.id} ${part.title}"${model ? ` · model: ${model}` : ""}`);
	if (where.length) lines.push(`  within: ${where.join(" › ")}`);
	if (part.detail) lines.push(`  task: ${part.detail}`);
	if (part.note) lines.push(`  note: ${part.note}`);
	const before = waitsFor(workflow, part).filter((p) => p.result);
	if (before.length) lines.push(`  results it builds on: ${before.map((p) => `${p.id}: ${p.result!.replace(/\s+/g, " ").slice(0, 200)}`).join(" | ")}`);
	if (part.attempts > 0) lines.push(`  attempt ${part.attempts + 1}: it failed before${part.note ? "" : "; try another way"}`);
	return lines.join("\n");
}

// =============================================================================
// Saving
// =============================================================================

/** The workflows of all sessions, one JSON file each. */
export class WorkflowStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(id: number): string {
		return join(this.dir, `${id}.json`);
	}

	save(workflow: Workflow): void {
		mkdirSync(this.dir, { recursive: true });
		const file = this.file(workflow.id);
		const temp = `${file}.tmp`;
		writeFileSync(temp, `${JSON.stringify(workflow, null, 2)}\n`);
		renameSync(temp, file);
	}

	load(id: number): Workflow | undefined {
		try {
			const workflow = JSON.parse(readFileSync(this.file(id), "utf8")) as Workflow;
			workflow.news ??= [];
			return workflow;
		} catch {
			return undefined;
		}
	}

	/** All saved workflows, newest first. */
	list(): Workflow[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.map((name) => /^(\d+)\.json$/.exec(name)?.[1])
			.filter((id): id is string => Boolean(id))
			.map((id) => this.load(Number(id)))
			.filter((w): w is Workflow => Boolean(w))
			.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
	}

	remove(id: number): void {
		rmSync(this.file(id), { force: true });
	}

	nextId(): number {
		if (!existsSync(this.dir)) return 1;
		const taken = readdirSync(this.dir).map((name) => Number(/^(\d+)\.json$/.exec(name)?.[1] ?? 0));
		return Math.max(0, ...taken) + 1;
	}

	/** The newest workflow of this folder that has not ended. */
	latestOpen(cwd: string): Workflow | undefined {
		return this.list().find((w) => w.cwd === cwd && w.state !== "done" && w.state !== "stopped" && w.state !== "review");
	}
}
