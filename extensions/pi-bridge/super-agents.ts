/**
 * Super-subagents: instead of the CLI's own subagents, whose work comes back
 * only as a summary, the agent hands tasks to `super_agents`. Each task becomes
 * a new, independent run of the agent's CLI (own process, own session, every
 * tool of a main session: MCP servers, skills, its own subagents), started by
 * the provider extension over SUPER_AGENT_CHANNEL and shown live, thinking and
 * tool calls included, in the subagents popup.
 *
 * The option is off by default; `/super-subagents` switches it and pi keeps it
 * in <agent dir>/pi-bridge.json. While it is on, the CLI's own subagent tool is
 * switched off (Claude's Agent/Task, agy's invoke_subagent), so the agent uses
 * this one. A super-subagent gets no super-subagents of its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SUPER_AGENT_CHANNEL, type SuperAgentRequest, type SuperAgentResult } from "../shared/agent-bus.ts";
import type { BridgeClient, BridgeTool, ToolResult } from "./server.ts";

export const SUPER_TOOL = "super_agents";
/** Tag of the bridge clients that are super-subagents themselves. */
export const SUPER_TAG = "super";
/** Most tasks in one call. */
export const MAX_SUPER_TASKS = 8;
/** Claude's own subagent tools, switched off while super-subagents are on. */
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task"];
/** agy's own subagent tool, denied by its hook while super-subagents are on. */
export const AGY_SUBAGENT_TOOL = "invoke_subagent";

const settingsFile = () => join(getAgentDir(), "pi-bridge.json");

function readSettings(): Record<string, unknown> {
	try {
		const value = JSON.parse(readFileSync(settingsFile(), "utf8"));
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

/** Whether super-subagents are on. */
export function superAgentsOn(): boolean {
	return readSettings().superSubagents === true;
}

export function setSuperAgents(on: boolean): void {
	const file = settingsFile();
	if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ ...readSettings(), superSubagents: on }, null, 2)}\n`);
}

/** Whether `client` may hand out super-subagents: the option is on and it is not one itself. */
export const offersSuperAgents = (client: BridgeClient) =>
	(client.kind === "claude" || client.kind === "agy") && client.tag !== SUPER_TAG && superAgentsOn();

export interface SuperTask {
	description: string;
	prompt: string;
	model?: string;
}

/** The tasks of a call, checked; throws with what is wrong. */
export function superTasks(args: Record<string, any>): SuperTask[] {
	const list = Array.isArray(args.tasks) ? args.tasks : [];
	if (list.length === 0) throw new Error("`tasks` is empty.");
	if (list.length > MAX_SUPER_TASKS) throw new Error(`At most ${MAX_SUPER_TASKS} tasks in one call.`);
	return list.map((task: any, i: number) => {
		const prompt = typeof task?.prompt === "string" ? task.prompt.trim() : "";
		if (!prompt) throw new Error(`Task ${i + 1} has no prompt.`);
		const description = (typeof task?.description === "string" && task.description.trim()) || prompt.split("\n")[0].slice(0, 60);
		const model = typeof task?.model === "string" && task.model.trim() ? task.model.trim() : undefined;
		return { description, prompt, model };
	});
}

/** The answer to a call: every task's full result in order. */
export function superReport(tasks: SuperTask[], results: SuperAgentResult[]): string {
	const failed = results.filter((r) => r.isError).length;
	const head =
		tasks.length === 1
			? `The super-subagent ${failed ? "failed" : "is done"}.`
			: `${tasks.length} super-subagents finished: ${tasks.length - failed} done${failed ? `, ${failed} failed` : ""}.`;
	const parts = tasks.map((task, i) => {
		const r = results[i];
		const meta = [
			r.isError ? "failed" : "done",
			r.model,
			r.tokens ? `${r.tokens.toLocaleString("en-US")} tokens` : undefined,
			r.session ? `session ${r.session}` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		return `## ${i + 1}. ${task.description} (${meta})\n\n${r.text.trim() || "(no answer)"}`;
	});
	return [head, ...parts].join("\n\n");
}

/** Runs one task through the provider extension; resolves with its result. */
export function runSuperTask(
	emit: (channel: string, data: unknown) => void,
	provider: string,
	cwd: string,
	task: SuperTask,
	signal?: AbortSignal,
): Promise<SuperAgentResult> {
	return new Promise((resolve) => {
		let claimed = false;
		let done = false;
		const reply = (result: SuperAgentResult) => {
			if (done) return;
			done = true;
			resolve(result);
		};
		emit(SUPER_AGENT_CHANNEL, {
			provider,
			description: task.description,
			prompt: task.prompt,
			model: task.model,
			cwd,
			signal,
			claim: () => {
				claimed = true;
			},
			reply,
		} satisfies SuperAgentRequest);
		if (!claimed) reply({ text: `No extension runs super-subagents for provider "${provider}".`, isError: true });
	});
}

export function superAgentsTool(emit: (channel: string, data: unknown) => void, cwdOf: (client: BridgeClient) => string): BridgeTool {
	return {
		name: SUPER_TOOL,
		description: `Run tasks in super-subagents. Use this instead of your built-in subagents (the Agent/Task tool, invoke_subagent), which are switched off while pi's super-subagents are on. Each task is a new, independent run of your own CLI, in its own process and session, with every tool of a main session: MCP servers, skills, its own subagents. The user watches each one live (thinking, tool calls, text) in pi's subagents popup. A super-subagent does not see this conversation, so each prompt must say everything it needs: the goal, the files and facts it builds on, what to hand back. The tasks of one call run in parallel; the call returns when all are done, with each one's full final answer. Up to ${MAX_SUPER_TASKS} tasks per call.`,
		inputSchema: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: MAX_SUPER_TASKS,
					description: "The tasks, run in parallel.",
					items: {
						type: "object",
						properties: {
							description: { type: "string", description: "What it does, in 3–6 words, shown to the user." },
							prompt: { type: "string", description: "The complete task for the super-subagent." },
							model: { type: "string", description: "Model for it (e.g. sonnet, haiku, opus); default the model selected in pi." },
						},
						required: ["description", "prompt"],
					},
				},
			},
			required: ["tasks"],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		only: ["claude", "agy"],
		visible: offersSuperAgents,
		async call(args, client, signal): Promise<ToolResult> {
			if (!offersSuperAgents(client)) return { text: "Super-subagents are off.", isError: true };
			let tasks: SuperTask[];
			try {
				tasks = superTasks(args);
			} catch (error) {
				return { text: error instanceof Error ? error.message : String(error), isError: true };
			}
			const cwd = cwdOf(client);
			const results = await Promise.all(tasks.map((task) => runSuperTask(emit, client.provider, cwd, task, signal)));
			return { text: superReport(tasks, results), isError: results.every((r) => r.isError) };
		},
	};
}
