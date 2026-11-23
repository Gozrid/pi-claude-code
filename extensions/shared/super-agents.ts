/**
 * Bookkeeping the provider extensions share for super-subagents (see
 * SUPER_AGENT_CHANNEL in agent-bus.ts): the runs of a session as subagents for
 * the subagents extension, published at most every PUBLISH_MS while they
 * stream, and the way to stop them.
 */

import type { Subagent, SubagentStep } from "./agent-bus.ts";
import { MAX_STEPS } from "./subagent-files.ts";

const PUBLISH_MS = 100;

/** Appends live text to the step of kind `kind` that was opened last for a block, or opens one. */
export function appendStep(steps: SubagentStep[], kind: "text" | "thinking", text: string, open: boolean): void {
	const last = steps[steps.length - 1];
	if (!open && last?.kind === kind) last.text += text;
	else steps.push({ kind, text });
}

/** Drops empty text and thinking steps (e.g. thinking the CLI does not show), keeps the rest in place. */
export function dropEmptySteps(steps: SubagentStep[]): void {
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if ((step.kind === "text" || step.kind === "thinking") && !step.text.trim()) steps.splice(i, 1);
	}
}

/** Drops the oldest steps beyond MAX_STEPS, keeping the prompt. */
export function trimLive(steps: SubagentStep[]): void {
	const over = steps.length - MAX_STEPS;
	if (over > 0) steps.splice(steps[0]?.kind === "prompt" ? 1 : 0, over);
}

export class SuperAgentList {
	readonly agents: Subagent[] = [];
	private readonly stoppers = new Map<string, () => void>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private next = 1;

	private readonly publish: (agents: Subagent[]) => void;

	constructor(publish: (agents: Subagent[]) => void) {
		this.publish = publish;
	}

	/** A new running super-subagent; `stop` ends its process. */
	add(description: string, type: string, prompt: string, stop: () => void): Subagent {
		const now = Date.now();
		const agent: Subagent = {
			id: `super-${this.next++}`,
			description,
			type,
			status: "running",
			startedAt: now,
			lastAt: now,
			steps: [{ kind: "prompt", text: prompt }],
		};
		this.agents.push(agent);
		this.stoppers.set(agent.id, stop);
		this.changed(true);
		return agent;
	}

	/** Something of `agent` changed; publishes soon (now with `now`). */
	changed(now = false): void {
		if (now) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = undefined;
			this.publish([...this.agents]);
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.publish([...this.agents]);
		}, PUBLISH_MS);
		this.timer.unref?.();
	}

	/** The run is over. */
	finish(agent: Subagent, ok: boolean): void {
		agent.status = ok ? "done" : "stopped";
		agent.lastAt = Date.now();
		this.stoppers.delete(agent.id);
		dropEmptySteps(agent.steps);
		this.changed(true);
	}

	get running(): number {
		return this.stoppers.size;
	}

	/** Stops every running super-subagent. */
	stopAll(): void {
		for (const stop of [...this.stoppers.values()]) stop();
	}

	/** Forgets the finished ones (a new session). */
	clearFinished(): void {
		const keep = this.agents.filter((a) => this.stoppers.has(a.id));
		this.agents.splice(0, this.agents.length, ...keep);
		this.changed(true);
	}
}
