/**
 * Super-subagents for agy (see SUPER_AGENT_CHANNEL in shared/agent-bus.ts):
 * each task is an `agy --print` of its own, in a conversation of its own, with
 * every tool of a main run (pi's MCP servers, its own subagents, pi's
 * permission prompts in the mode pi is in). Its stream becomes the subagent's
 * steps as it comes, thinking and text while they are written, and the run's
 * final answer goes back whole.
 */

import type { Subagent, SuperAgentRequest, SuperAgentResult } from "../shared/agent-bus.ts";
import { resultStep } from "../shared/subagent-files.ts";
import { appendStep, type SuperAgentList, trimLive } from "../shared/super-agents.ts";
import { type AgyModel, spawnAgy, stopAgy, variantId } from "./cli.ts";
import { piMcpArgs } from "./mcp.ts";
import { runtime } from "./state.ts";
import { errorText, QUIET_TOOLS, scratchDir, toolDetail, toolName } from "./stream.ts";

const EXIT_GRACE_MS = 3000;

export function superPrompt(task: string, scratch: string): string {
	return `You are a super-subagent: another agent in pi (a terminal chat app) handed you the task below and waits for your result. You run as a full session of your own; the user can watch everything you do live.

- Do the task completely and on your own; nobody answers questions in between, except pi's permission and question dialogs.
- Your final message is handed back word for word to the agent that started you, as your result. Make it complete and self-contained: what you did, what you found, the files you changed, anything left open.
- Files you need only for trying things out (scripts, temporary output) go into the scratch directory ${scratch}.

The task:

${task}`;
}

/** The arguments of a super-subagent's agy run. */
export function superArgs(command: string, provider: string, prompt: string, options: { model?: string; scratch: string }): string[] {
	const args = [`--print=${prompt}`, "--output-format", "stream-json", ...(options.model ? ["--model", options.model] : []), "--add-dir", options.scratch];
	const mode = runtime.mode;
	if (mode === "bypass") args.push("--dangerously-skip-permissions");
	else if (mode !== "default") args.push("--mode", mode);
	args.push(...piMcpArgs(command, false, provider, true));
	const extra = process.env.PI_AGY_EXTRA_ARGS?.trim();
	if (extra) args.push(...extra.split(/\s+/));
	return args;
}

/** agy's model id for a task: a family gets the variant of pi's thinking level; anything else is taken as it is. */
export function superModel(models: readonly AgyModel[], model: string | undefined, level: string | undefined): string | undefined {
	if (!model) return undefined;
	const family = models.find((m) => m.id === model);
	return family ? variantId(family, model, level) : model;
}

/** Reads a super-subagent's stream-json lines into its steps; `result` is set once the run is over. */
export class AgySuperFeed {
	conversation?: string;
	result?: SuperAgentResult;
	/** Tool steps seen, by step index. */
	private tools = new Map<number, { quiet: boolean; done: boolean }>();
	/** Steps that streamed text or thinking, by step index and kind. */
	private open = new Set<string>();
	/** Text of the last model step that wrote any, in case the result has none. */
	private lastText = "";
	private lastTextStep: number | undefined;

	private readonly agent: Subagent;
	private readonly model: string | undefined;

	constructor(agent: Subagent, model?: string) {
		this.agent = agent;
		this.model = model;
	}

	feed(msg: any): boolean {
		if (!msg || typeof msg !== "object") return false;
		if (typeof msg.conversation_id === "string") this.conversation ??= msg.conversation_id;
		const steps = this.agent.steps;
		const touch = () => {
			this.agent.lastAt = Date.now();
			trimLive(steps);
			return true;
		};
		if (msg.event === "step_update") {
			const step = msg.step_update ?? {};
			const index = step.step_index;
			if (step.step_type === "agent_response") {
				let changed = false;
				for (const kind of ["thinking", "text"] as const) {
					const delta = step[`${kind}_delta`];
					if (typeof delta !== "string" || !delta) continue;
					const key = `${index}:${kind}`;
					appendStep(steps, kind, delta, !this.open.has(key));
					this.open.add(key);
					if (kind === "text") {
						if (this.lastTextStep !== index) this.lastText = "";
						this.lastTextStep = index;
						this.lastText += delta;
					}
					changed = true;
				}
				// Thinking that came only with the finished step.
				if (step.state !== "ACTIVE" && typeof step.thinking === "string" && step.thinking.trim() && !this.open.has(`${index}:thinking`)) {
					this.open.add(`${index}:thinking`);
					steps.push({ kind: "thinking", text: step.thinking });
					changed = true;
				}
				return changed ? touch() : false;
			}
			if (step.step_type === "tool") {
				const info = step.tool_info ?? {};
				const raw: string = step.tool_name ?? info.name ?? "tool";
				let tool = this.tools.get(index);
				let changed = false;
				if (!tool) {
					tool = { quiet: QUIET_TOOLS.has(raw), done: false };
					this.tools.set(index, tool);
					if (!tool.quiet) {
						const name = toolName(raw);
						const detail = toolDetail(info.parameters) || undefined;
						this.agent.lastTool = { name, detail };
						steps.push({ kind: "tool", name, detail });
						changed = true;
					}
				}
				if (!tool.done && (step.state === "DONE" || step.state === "ERROR")) {
					tool.done = true;
					const failed = step.state === "ERROR";
					if (!tool.quiet || failed) {
						const text = failed ? String(info.error?.message ?? "failed") : typeof info.output === "string" ? info.output : "";
						steps.push(resultStep(text, failed));
						changed = true;
					}
				}
				return changed ? touch() : false;
			}
			return false;
		}
		if (msg.event === "result") {
			const result = msg.result ?? {};
			if (typeof result.conversation_id === "string") this.conversation = result.conversation_id;
			const u = result.usage ?? {};
			const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) + (u.cache_read_tokens ?? 0);
			const isError = result.status !== "SUCCESS";
			const response = typeof result.response === "string" ? result.response.trim() : "";
			const text = response || (isError ? `Antigravity finished with ${result.status ?? "an error"}.` : this.lastText.trim());
			this.result = { text, isError, session: this.conversation, model: this.model, tokens: tokens || undefined };
			if (isError) steps.push({ kind: "result", text, isError: true });
			return touch();
		}
		return false;
	}
}

/** Runs one super-subagent; replies to `request` when it is over. */
export function runAgySuperAgent(list: SuperAgentList, command: string, request: SuperAgentRequest, model: string | undefined): void {
	const scratch = scratchDir(runtime.sessionId);
	const args = superArgs(command, request.provider, superPrompt(request.prompt, scratch), { model, scratch });
	const child = spawnAgy(command, args, { cwd: request.cwd });
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		stopAgy(child, "SIGINT");
		setTimeout(() => stopAgy(child, "SIGKILL"), EXIT_GRACE_MS).unref();
	};
	const agent = list.add(request.description, `super · ${model ?? "default"}`, request.prompt, stop);
	const feed = new AgySuperFeed(agent, model);
	let stderr = "";
	let buffer = "";
	let replied = false;
	const reply = (result: SuperAgentResult) => {
		if (replied) return;
		replied = true;
		request.signal?.removeEventListener("abort", stop);
		list.finish(agent, !result.isError);
		request.reply(result);
	};

	if (request.signal?.aborted) stop();
	request.signal?.addEventListener("abort", stop, { once: true });
	child.stderr.on("data", (d) => {
		stderr += d.toString();
	});
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line) continue;
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (feed.feed(msg)) list.changed();
			if (feed.result) {
				reply(feed.result);
				setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) stopAgy(child, "SIGTERM");
				}, EXIT_GRACE_MS).unref();
			}
		}
	});
	let ended = false;
	child.stdout.on("end", () => {
		ended = true;
	});
	child.on("error", (error) => reply({ text: `agy could not be started: ${error.message}`, isError: true, model }));
	child.on("exit", (code) => {
		const gone = () => {
			const why = stopped ? "The super-subagent was stopped." : errorText(stderr) || `agy exited with code ${code} without a result.`;
			reply({ text: why, isError: true, session: feed.conversation, model });
		};
		if (ended) gone();
		else {
			child.stdout.once("end", gone);
			setTimeout(gone, 2000).unref();
		}
	});
	child.stdin.on("error", () => {});
	child.stdin.end();
}
