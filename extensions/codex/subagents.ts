import type { Subagent, SubagentStep } from "../shared/agent-bus.ts";
import { trimLive } from "../shared/super-agents.ts";
import type { Fields } from "./client.ts";
import { toolInfo } from "./protocol.ts";

/** App-server interleaves child-thread notifications with the parent turn on the same connection. */
export class CodexSubagents {
	private readonly agents = new Map<string, Subagent>();
	private readonly publish: (agent: Subagent) => void;
	constructor(publish: (agent: Subagent) => void) {
		this.publish = publish;
	}

	private update(id: string, status: Subagent["status"], name?: string, model?: string, step?: SubagentStep) {
		if (!id) return;
		const agent = this.agents.get(id) ?? { id, description: id, startedAt: Date.now(), status, steps: [] };
		agent.status = status;
		agent.lastAt = Date.now();
		if (name) agent.description = name;
		if (model) agent.type = model;
		const last = agent.steps.at(-1);
		if (step && JSON.stringify(last) !== JSON.stringify(step)) {
			agent.steps.push(step);
			if (step.kind === "tool") agent.lastTool = { name: step.name, detail: step.detail };
			trimLive(agent.steps);
		}
		this.agents.set(id, agent);
		this.publish(agent);
	}

	receive(root: string, method: string, p: Fields) {
		const parent = (id: string) => !!id && (id === root || this.agents.has(id));
		if (method === "thread/started" && parent(p.thread.parentThreadId)) {
			this.update(p.thread.id, "running", p.thread.preview, p.thread.model);
			return;
		}
		if (!parent(p.threadId)) return;
		const item = p.item;
		const completed = method === "item/completed";
		if (item && (completed || method === "item/started")) {
			if (item.type === "collabAgentToolCall") {
				for (const id of item.receiverThreadIds ?? []) {
					const state = item.agentsStates?.[id];
					const status =
						state?.status === "completed"
							? "done"
							: ["interrupted", "shutdown", "errored", "notFound"].includes(state?.status)
								? "stopped"
								: "running";
					const step = item.prompt && !this.agents.has(id) ? { kind: "prompt" as const, text: item.prompt } : undefined;
					this.update(id, status, item.prompt, item.model, step);
					if (state?.message) this.update(id, status, undefined, undefined, { kind: "text", text: state.message });
				}
			}
			if (item.type === "subAgentActivity")
				this.update(
					item.agentThreadId,
					item.kind === "completed" ? "done" : item.kind === "interrupted" ? "stopped" : "running",
					undefined,
					item.model,
				);
			if (p.threadId === root) return;
			const tool = toolInfo(item);
			if (tool && !completed)
				this.update(p.threadId, "running", undefined, undefined, { kind: "tool", name: tool.name, detail: tool.detail });
			const text = item.text ?? item.summary?.join("\n");
			if (completed && text)
				this.update(p.threadId, "running", undefined, undefined, { kind: item.type === "reasoning" ? "thinking" : "text", text });
		}
		if (method === "turn/completed" && p.threadId !== root)
			this.update(p.threadId, p.turn.status === "completed" ? "done" : "stopped");
	}
}
