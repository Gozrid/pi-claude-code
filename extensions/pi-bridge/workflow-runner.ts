/**
 * Runs workflows (workflow.ts) for the tools: keeps the current one, saves
 * every change, opens the review, asks the user about parts that failed twice
 * and wakes the agent when the user lets a paused workflow go on.
 *
 * What it shows and how it asks is up to index.ts (the options); the texts the
 * agent gets are made here.
 */

import type { AskAnswer, AskQuestion } from "./ask.ts";
import {
	afterRestart,
	buildWorkflow,
	decideFailure,
	describeTree,
	type FailureChoice,
	findPart,
	MAX_ATTEMPTS,
	nextParts,
	partBrief,
	readyParts,
	type Part,
	progressOf,
	setPaused,
	takeNews,
	updatePart,
	type Workflow,
	WorkflowStore,
} from "./workflow.ts";

export type ReviewResult = { kind: "approved" } | { kind: "feedback"; text: string } | { kind: "closed" };

export interface RunnerOptions {
	store: WorkflowStore;
	/** Called after every change of the current workflow (or when it went away). */
	onChange?(): void;
	/** Shows the plan for review; resolves with the user's decision. Unset: no UI. */
	review?(workflow: Workflow): Promise<ReviewResult>;
	/** Asks the user questions in a dialog. Unset: no UI. */
	ask?(questions: AskQuestion[], title: string): Promise<AskAnswer[] | undefined>;
	/** Sends the agent a message that starts a turn (or follows the running one). */
	wake?(workflow: Workflow, text: string): void;
	now?(): number;
}

export const RETRY = "Try again";
export const SKIP = "Skip it";
export const PAUSE = "Pause the workflow";

/** How the agent runs an approved workflow. */
export const HOW_TO_RUN = `Run it like this, without asking the user in between:
1. Call workflow_next. It gives you the small parts that can start now and marks them running.
2. For each, start a subagent (your Agent/Task tool; several at once in the background where your tools allow it) with the description and model given and a prompt with the part's task, where it fits in and the results it builds on. Tell it to end with a short summary of what it did.
3. When a subagent ends, call workflow_update with the part's id, status done or failed, result (its short summary) and tokens (the subagent's total tokens from its usage, if you know them).
4. Call workflow_next again and again until it says the workflow is finished; then tell the user what was done.
Do the parts only through subagents; you coordinate. When workflow_next says the workflow is paused or waits for the user, end your turn: pi sends you a message when it goes on.`;

export class WorkflowRunner {
	current: Workflow | undefined;
	/** Workflows whose agent was told to end its turn (finished, waiting for the user): a change that frees parts wakes it. */
	private idle = new Set<number>();
	private o: RunnerOptions;

	constructor(o: RunnerOptions) {
		this.o = o;
	}

	private now(): number {
		return this.o.now?.() ?? Date.now();
	}

	/** Saves the workflow and shows it anew. */
	changed(workflow: Workflow): void {
		this.o.store.save(workflow);
		if (workflow.id === this.current?.id) this.current = workflow;
		this.o.onChange?.();
	}

	/** At session start: the newest unfinished workflow of this folder, paused until the user goes on. */
	restore(cwd: string): Workflow | undefined {
		if (this.current) return this.current;
		const workflow = this.o.store.latestOpen(cwd);
		if (!workflow) return undefined;
		afterRestart(workflow, this.now());
		this.current = workflow;
		this.changed(workflow);
		return workflow;
	}

	/** The workflow a tool means: the given id, else the current one. */
	resolve(id: unknown): Workflow {
		if (id !== undefined && id !== null && id !== "") {
			const wanted = Number(String(id).replace(/^#/, ""));
			if (this.current?.id === wanted) return this.current;
			const loaded = this.o.store.load(wanted);
			if (!loaded) throw new Error(`No workflow #${id}.`);
			this.current = loaded;
			this.o.onChange?.();
			return loaded;
		}
		if (!this.current) throw new Error("No workflow is running; plan one with workflow_plan.");
		return this.current;
	}

	// -------------------------------------------------------------------------
	// The tools
	// -------------------------------------------------------------------------

	/** workflow_plan: builds the workflow, has the user review it and says how it went. */
	async plan(args: Record<string, unknown>, cwd: string): Promise<string> {
		if (!this.o.review) throw new Error("pi runs without a user interface (print or JSON mode), so nobody can review the plan.");
		const workflow = buildWorkflow(args, { id: this.o.store.nextId(), cwd, now: this.now() });
		const before = this.current;
		this.current = workflow;
		this.changed(workflow);
		const result = await this.o.review(workflow);
		const tree = describeTree(workflow);
		if (result.kind === "approved") {
			workflow.state = "running";
			workflow.news = [];
			workflow.updatedAt = this.now();
			this.changed(workflow);
			const p = progressOf(workflow);
			return `The user approved workflow #${workflow.id} "${workflow.title}" (${p.total} small parts, up to ${workflow.parallel} at once). The plan as approved, with the user's edits:\n${tree}\n\n${HOW_TO_RUN}`;
		}
		// A plan that was not approved is not kept.
		this.o.store.remove(workflow.id);
		this.current = before?.state === "review" ? undefined : before;
		this.o.onChange?.();
		if (result.kind === "feedback")
			return `The user did not approve the plan yet and wants this changed: ${result.text}\nThe plan as they left it (with their edits):\n${tree}\nPropose the changed plan with workflow_plan again.`;
		return `The user closed the review without approving the plan; do not run it as a workflow. The plan as they left it:\n${tree}`;
	}

	/** workflow_next: the parts to start now, or why there are none, with what the user changed. */
	next(id: unknown): string {
		const workflow = this.resolve(id);
		const now = this.now();
		const result = nextParts(workflow, now);
		if (result.kind === "start" || result.kind === "wait") this.idle.delete(workflow.id);
		else this.idle.add(workflow.id);
		const news = takeNews(workflow);
		this.changed(workflow);
		const told = news.length ? `What the user changed since your last call:\n${news.map((n) => `- ${n}`).join("\n")}\n\n` : "";
		const ids = (parts: Part[]) => parts.map((p) => p.id).join(", ");
		switch (result.kind) {
			case "start":
				return `${told}Start these ${result.parts.length} part(s) now, each in a subagent (they are marked running):\n${result.parts.map((p) => partBrief(workflow, p)).join("\n")}\n\nCall workflow_update for each when its subagent ends, then workflow_next.`;
			case "wait":
				return `${told}Nothing else can start yet: ${ids(result.running)} running (up to ${workflow.parallel} at once, or the rest waits for them). Wait for their subagents, call workflow_update when one ends, then workflow_next.`;
			case "paused":
				return `${told}The user paused workflow #${workflow.id}. Start nothing new; report the subagents still running with workflow_update when they end, then end your turn. pi sends you a message when the user continues.`;
			case "asking":
				return `${told}Part(s) ${ids(result.parts)} failed ${MAX_ATTEMPTS} times and the user decides what happens to them; nothing else can start now. End your turn; pi sends you a message with the decision.`;
			case "blocked":
				return `${told}The open parts wait for ${ids(result.parts)}, which failed. End your turn; the user can restart or cancel them in the workflow popup, and pi sends you a message when it goes on.`;
			case "done":
				return `${told}Workflow #${workflow.id} "${workflow.title}" is finished.\n${describeTree(workflow, { results: true })}\nTell the user what was done.`;
			case "stopped":
				return `${told}Workflow #${workflow.id} was stopped; do not go on with it.`;
			case "review":
				return `Workflow #${workflow.id} waits for the user's review.`;
		}
	}

	/** workflow_update: how a small part ended. */
	update(args: Record<string, unknown>): string {
		const workflow = this.resolve(args.workflow);
		const { part, outcome } = updatePart(workflow, args.id, args.status, { result: args.result, tokens: args.tokens, note: args.note }, this.now());
		this.changed(workflow);
		const p = progressOf(workflow);
		const progress = `${p.done} of ${p.total} small parts done${p.running ? `, ${p.running} running` : ""}.`;
		switch (outcome) {
			case "retry":
				return `Part ${part.id} failed; it is handed out once more by workflow_next, so try another way then (keep what you learned in its prompt). ${progress} Call workflow_next.`;
			case "ask":
				void this.askAboutFailure(workflow, part);
				return `Part ${part.id} failed ${MAX_ATTEMPTS} times; the user is asked what to do with it. ${progress} Go on with workflow_next for the other parts.`;
			case "ignored":
				return `The user cancelled part ${part.id} meanwhile; its result is not used. ${progress} Call workflow_next.`;
			default:
				return `Part ${part.id}: ${part.status}. ${progress} Call workflow_next.`;
		}
	}

	/** workflow_status: the tree with results, or the saved workflows. */
	status(args: Record<string, unknown>, cwd: string): string {
		if (args.list) {
			const all = this.o.store.list().filter((w) => w.cwd === cwd);
			if (all.length === 0) return "No workflows saved for this folder.";
			return all.map((w) => `#${w.id} ${w.title} · ${w.state} · ${progressOf(w).done}/${progressOf(w).total} done · ${new Date(w.updatedAt).toISOString().slice(0, 16)}`).join("\n");
		}
		return describeTree(this.resolve(args.workflow), { results: true });
	}

	// -------------------------------------------------------------------------
	// What the user does
	// -------------------------------------------------------------------------

	/** A change from the popup; returns an error to show. */
	apply(workflow: Workflow, change: (workflow: Workflow, now: number) => void): string | undefined {
		try {
			change(workflow, this.now());
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		this.changed(workflow);
		this.wakeIfFreed(workflow, "The user changed workflow");
		return undefined;
	}

	/** An idle agent goes on when a change lets parts start (e.g. a failed part restarted). */
	private wakeIfFreed(workflow: Workflow, what: string): void {
		if (!this.idle.has(workflow.id) || workflow.state !== "running" || readyParts(workflow).length === 0) return;
		this.idle.delete(workflow.id);
		this.o.wake?.(workflow, `${what} #${workflow.id} "${workflow.title}" so parts can start again. Call workflow_next (workflow ${workflow.id}) and go on with it.`);
	}

	/** Pauses or continues; continuing wakes the agent. */
	pause(workflow: Workflow, paused: boolean): void {
		if (!setPaused(workflow, paused, this.now())) return;
		if (paused) workflow.news.push("The user paused the workflow.");
		this.changed(workflow);
		if (!paused) this.idle.delete(workflow.id);
		if (!paused) this.o.wake?.(workflow, `The user continued workflow #${workflow.id} "${workflow.title}". Call workflow_next (workflow ${workflow.id}) and go on with it.`);
	}

	private async askAboutFailure(workflow: Workflow, part: Part): Promise<void> {
		if (!this.o.ask) return;
		const question: AskQuestion = {
			header: `Part ${part.id}`,
			question: `Part ${part.id} "${part.title}" of workflow #${workflow.id} failed ${MAX_ATTEMPTS} times. What now?`,
			...(part.note || part.result ? { preview: [part.note, part.result].filter(Boolean).join("\n\n") } : {}),
			options: [
				{ label: RETRY, recommended: true, description: "Hand it out once more; the other parts go on.", input: "Hint for the next try (optional)" },
				{ label: SKIP, description: "Leave it out; parts that wait for it can start." },
				{ label: PAUSE, description: "Start nothing new until you continue it (p in the popup)." },
			],
		};
		let answers: AskAnswer[] | undefined;
		try {
			answers = await this.o.ask([question], `Workflow #${workflow.id} ${workflow.title}`);
		} catch {
			return;
		}
		const answer = answers?.[0];
		// Closed without an answer: it stays failed; restart or cancel in the popup.
		if (!answer || (!answer.selected.length && !answer.own)) return;
		const choice: FailureChoice = answer.selected[0] === SKIP ? "skip" : answer.selected[0] === PAUSE ? "pause" : "retry";
		const hint = [answer.extra?.text, answer.own].filter(Boolean).join("\n") || undefined;
		// Meanwhile the user may have cancelled, restarted or removed it in the popup.
		const live = this.current?.id === workflow.id ? this.current : workflow;
		if (!live.asking?.includes(part.id)) return;
		const text = decideFailure(live, part.id, choice, hint, this.now());
		this.changed(live);
		if (choice === "pause") return;
		this.idle.delete(live.id);
		this.o.wake?.(live, `${text} Call workflow_next (workflow ${live.id}) and go on.`);
	}
}
