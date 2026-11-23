/**
 * Super-subagents for Claude (see SUPER_AGENT_CHANNEL in shared/agent-bus.ts):
 * each task is a `claude -p` of its own, with its own saved session and every
 * tool of a main session (pi's MCP servers, skills, its own subagents, pi's
 * permission prompts in the mode pi is in). Its stream (with partial messages)
 * becomes the subagent's steps as it comes, so the popup shows thinking and
 * text while they are written, and the run's final answer goes back whole.
 */

import type { Subagent, SuperAgentRequest, SuperAgentResult } from "../shared/agent-bus.ts";
import { resultStep } from "../shared/subagent-files.ts";
import { appendStep, type SuperAgentList, trimLive } from "../shared/super-agents.ts";
import { spawnClaude, stopClaude, thinkingDisplayArgs } from "./cli.ts";
import type { InstanceState } from "./state.ts";
import { runtime } from "./state.ts";
import { piMcpArgs, scratchDir, summarizeToolInput, toolResultText } from "./stream.ts";

/** How long a finished run may take to exit before it is stopped. */
const EXIT_GRACE_MS = 3000;

export function superInstructions(scratch: string): string {
	return `You are a super-subagent: another agent in pi (a terminal chat app) handed you the task below and waits for your result. You run as a full session of your own; the user can watch everything you do live.

- Do the task completely and on your own; nobody answers questions in between, except pi's permission and question dialogs.
- Your final message is handed back word for word to the agent that started you, as your result. Make it complete and self-contained: what you did, what you found, the files you changed, anything left open.
- Files you need only for trying things out (scripts, temporary output) go into the scratch directory ${scratch}.`;
}

/** The arguments of a super-subagent's claude run. */
export function superArgs(state: InstanceState, provider: string, options: { model?: string; effort?: string; scratch: string }): string[] {
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		...(options.model ? ["--model", options.model] : []),
		"--permission-mode",
		runtime.permissionMode,
		...thinkingDisplayArgs(state),
		...(options.effort ? ["--effort", options.effort] : []),
		"--add-dir",
		options.scratch,
		"--append-system-prompt",
		superInstructions(options.scratch),
		...piMcpArgs(provider, state.instance.command, true),
	];
	const extra = process.env.PI_CLAUDE_EXTRA_ARGS?.trim();
	if (extra) args.push(...extra.split(/\s+/));
	return args;
}

/** Reads a super-subagent's stream-json lines into its steps; `result` is set once the run is over. */
export class ClaudeSuperFeed {
	session?: string;
	model?: string;
	result?: SuperAgentResult;
	/** Content blocks of the message being streamed, by index. */
	private blocks = new Map<number, { type: string; json: string; name?: string }>();
	/** Blocks were streamed since the last complete assistant message (which then repeats them). */
	private streamed = false;

	private readonly agent: Subagent;

	constructor(agent: Subagent) {
		this.agent = agent;
	}

	/** Takes one parsed line; true when the agent changed. */
	feed(msg: any): boolean {
		if (!msg || typeof msg !== "object") return false;
		if (typeof msg.session_id === "string") this.session = msg.session_id;
		// The super-subagent's own subagents: summarized by their Agent/Task call.
		if (msg.parent_tool_use_id) return false;
		const steps = this.agent.steps;
		const touch = () => {
			this.agent.lastAt = Date.now();
			trimLive(steps);
			return true;
		};
		if (msg.type === "system" && msg.subtype === "init") {
			if (typeof msg.model === "string") this.model = msg.model;
			return false;
		}
		if (msg.type === "stream_event") {
			const e = msg.event ?? {};
			if (e.type === "content_block_start") {
				const block = e.content_block ?? {};
				this.streamed = true;
				this.blocks.set(e.index, { type: block.type, json: "", name: block.name });
				if (block.type === "thinking") appendStep(steps, "thinking", block.thinking ?? "", true);
				else if (block.type === "text") appendStep(steps, "text", block.text ?? "", true);
				else return false;
				return touch();
			}
			if (e.type === "content_block_delta") {
				const block = this.blocks.get(e.index);
				const d = e.delta ?? {};
				if (d.type === "thinking_delta" && typeof d.thinking === "string") appendStep(steps, "thinking", d.thinking, false);
				else if (d.type === "text_delta" && typeof d.text === "string") appendStep(steps, "text", d.text, false);
				else if (d.type === "input_json_delta" && block && typeof d.partial_json === "string") {
					block.json += d.partial_json;
					return false;
				} else return false;
				return touch();
			}
			if (e.type === "content_block_stop") {
				const block = this.blocks.get(e.index);
				this.blocks.delete(e.index);
				if (block?.type !== "tool_use") return false;
				let input: unknown = {};
				try {
					input = block.json ? JSON.parse(block.json) : {};
				} catch {}
				this.tool(String(block.name ?? "tool"), input);
				return touch();
			}
			return false;
		}
		if (msg.type === "assistant") {
			// Normally streamed already; a message that was not is read whole.
			if (this.streamed) {
				this.streamed = false;
				return false;
			}
			let changed = false;
			for (const block of msg.message?.content ?? []) {
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) steps.push({ kind: "text", text: block.text });
				else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
					steps.push({ kind: "thinking", text: block.thinking });
				else if (block?.type === "tool_use") this.tool(String(block.name), block.input);
				else continue;
				changed = true;
			}
			return changed ? touch() : false;
		}
		if (msg.type === "user" && !msg.isReplay) {
			let changed = false;
			for (const block of msg.message?.content ?? []) {
				if (block?.type !== "tool_result") continue;
				steps.push(resultStep(toolResultText(block.content), !!block.is_error));
				changed = true;
			}
			return changed ? touch() : false;
		}
		if (msg.type === "result") {
			const u = msg.usage ?? {};
			const tokens =
				(u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
			const isError = !!msg.is_error || (msg.subtype !== undefined && msg.subtype !== "success");
			const text =
				typeof msg.result === "string" && msg.result.trim()
					? msg.result
					: isError
						? `Claude ended with ${msg.subtype ?? "an error"}${Array.isArray(msg.errors) && msg.errors.length ? `: ${msg.errors.join("; ")}` : ""}.`
						: "";
			this.result = { text, isError, session: this.session, model: this.model, tokens: tokens || undefined };
			if (isError && text) steps.push({ kind: "result", text, isError: true });
			return touch();
		}
		return false;
	}

	private tool(name: string, input: unknown): void {
		const detail = summarizeToolInput(input) || undefined;
		this.agent.lastTool = { name, detail };
		this.agent.steps.push({ kind: "tool", name, detail });
	}
}

/** Runs one super-subagent; replies to `request` when it is over. */
export function runClaudeSuperAgent(
	list: SuperAgentList,
	state: InstanceState,
	request: SuperAgentRequest,
	options: { model?: string; effort?: string },
): void {
	const scratch = scratchDir(runtime.sessionId);
	const args = superArgs(state, request.provider, { ...options, scratch });
	const child = spawnClaude(state.instance, args, { cwd: request.cwd });
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		stopClaude(child, "SIGINT");
		setTimeout(() => stopClaude(child, "SIGKILL"), EXIT_GRACE_MS).unref();
	};
	const agent = list.add(request.description, `super · ${options.model ?? "default"}`, request.prompt, stop);
	const feed = new ClaudeSuperFeed(agent);
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
				// Done: a claude that stays (background tasks) is ended after a moment.
				setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) stopClaude(child, "SIGTERM");
				}, EXIT_GRACE_MS).unref();
			}
		}
	});
	child.on("error", (error) => reply({ text: `Claude could not be started: ${error.message}`, isError: true, model: options.model }));
	let ended = false;
	child.stdout.on("end", () => {
		ended = true;
	});
	child.on("exit", (code) => {
		const gone = () => {
			const why = stopped ? "The super-subagent was stopped." : stderr.trim() || `Claude exited with code ${code} before it answered.`;
			reply({ text: why, isError: true, session: feed.session, model: feed.model ?? options.model });
		};
		// The last lines may still be on their way; an inherited pipe may also never end.
		if (ended) gone();
		else {
			child.stdout.once("end", gone);
			setTimeout(gone, 2000).unref();
		}
	});
	child.stdin.on("error", () => {});
	child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: request.prompt }] } })}\n`);
}
