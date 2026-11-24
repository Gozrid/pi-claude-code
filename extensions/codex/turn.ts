import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Activity, Subagent, Task, ToolEvent } from "../shared/agent-bus.ts";
import { toolBlockHeader } from "../shared/tool-lines.ts";
import { digest, scratchDir, type Instance } from "./accounts.ts";
import { CodexClient, type Fields } from "./client.ts";
import { CodexSubagents } from "./subagents.ts";
import { answerRequest, mcpConfig, modeParams, toolDisplay } from "./protocol.ts";

type Input = { type: "text"; text: string; text_elements: never[] } | { type: "image"; url: string };
const plain = (text: string): Input => ({ type: "text", text, text_elements: [] });
export function blocks(content: Message["content"]): Input[] {
	if (typeof content === "string") return content ? [plain(content)] : [];
	return content.flatMap((c): Input[] => {
		if (c.type === "text" && c.text) return [plain(c.text)];
		if (c.type === "image") return [{ type: "image", url: "data:" + c.mimeType + ";base64," + c.data }];
		return [];
	});
}
export interface TurnOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	instance: Instance;
	model: string;
	effort?: string;
	mode: string;
	session: string;
	reset: number;
	signal?: AbortSignal;
	context: Pick<TranscriptContext, "messages">;
	kind?: "title" | "super";
	system?: string;
	/** An interactive session keeps its successful connection for background work. */
	park?(client: CodexClient): void;
	background?(message: string): void;
}
export interface TurnEvents {
	delta(key: string, kind: "text" | "thinking", text: string): void;
	end(key: string): void;
	activity?(activity: Omit<Activity, "tokens">): void;
	tool?(event: ToolEvent): void;
	usage?(last: Fields, total: Fields, window?: number): void;
	limits?(snapshot: Fields): void;
	tasks?(tasks: Task[]): void;
	agents?(update: Subagent): void;
	ready?(steer: (text: string, images?: { mimeType: string; data: string }[]) => Promise<void>): void;
	resolved?(model: string): void;
	answer?(text: string): void;
	denied?(tool: string, detail: string): void;
}
export function turnInput(messages: Message[], resume: boolean): Input[] {
	const last = messages.map((m) => m.role).lastIndexOf("assistant");
	const input = messages.slice(last + 1).flatMap((m) => blocks(m.content));
	if (!resume && last >= 0) {
		const history = messages
			.slice(0, last + 1)
			.map((m) => {
				const value = blocks(m.content)
					.map((b) => (b.type === "image" ? "[image]" : /^[⏺⎿✗] /.test(b.text) ? toolBlockHeader(b.text) : b.text))
					.join("\n");
				return m.role + ": " + value;
			})
			.join("\n\n");
		input.unshift(plain("<previous_conversation>\n" + history + "\n</previous_conversation>\nContinue the conversation."));
	}
	return input.length ? input : [plain("Continue.")];
}

export async function runTurn(client: CodexClient, opts: TurnOptions, e: TurnEvents) {
	const { ctx, instance, signal, kind } = opts;
	const scope = digest(JSON.stringify([ctx.cwd, instance.id, instance.command, opts.session]));
	const scratch = scratchDir(opts.session);
	const messages = opts.context.messages.filter((m) => m.role !== "system");
	const previous = messages[messages.map((m) => m.role).lastIndexOf("assistant")];
	const previousId =
		previous?.role === "assistant" && previous.timestamp > opts.reset && previous.provider === instance.id
			? previous.responseId
			: undefined;
	const [lastScope, lastThread, lastTurn] = previousId?.split("/") ?? [];
	const dialogs = new AbortController();
	const dialogSignal = AbortSignal.any([dialogs.signal, client.signal]);
	let thread = "",
		turn = "";
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => {
		dialogs.abort();
		if (!thread || !turn) return client.close(new Error("Codex interrupted"));
		void client.request("turn/interrupt", { threadId: thread, turnId: turn }).catch(() => {});
		abortTimer ??= setTimeout(() => client.close(new Error("Codex interrupt timed out")), 2500);
	};
	signal?.throwIfAborted();
	signal?.addEventListener("abort", abort, { once: true });
	const items = new Map<string, Fields>();
	const received = new Set<string>();
	const agents = e.agents && new CodexSubagents(e.agents);
	let finished!: (result: Fields) => void;
	const done = new Promise<Fields>((resolve) => {
		finished = resolve;
	});
	let parked = false;
	const declined = new Set<string>();
	client.onRequest = async (method, p) => {
		const result = await answerRequest(kind === "title" ? undefined : ctx, method, p, dialogSignal, items.get(p.itemId));
		if ("decision" in result && result.decision !== "accept") declined.add(p.itemId);
		return result;
	};
	client.onEvent = (method, p) => {
		if (method === "account/rateLimits/updated") {
			e.limits?.(p.rateLimits);
			return;
		}
		if (thread) agents?.receive(thread, method, p);
		if (!thread || p.threadId !== thread) return;
		if (parked) {
			if (method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) opts.background?.(p.item.text);
			return;
		}
		if (method === "thread/tokenUsage/updated") {
			const u = p.tokenUsage;
			if (turn && p.turnId && p.turnId !== turn) return;
			e.usage?.(u.last, u.total, u.modelContextWindow);
			return;
		}
		if (turn && p.turnId && turn !== p.turnId) return;
		if (method === "turn/started") turn = p.turn.id;
		if (method === "turn/completed" && (!turn || p.turn.id === turn)) {
			finished(p.turn);
			return;
		}
		if (method === "turn/plan/updated") {
			e.tasks?.(
				p.plan.map((s: Fields, i: number) => ({
					id: String(i + 1),
					subject: s.step,
					status: s.status === "inProgress" ? "in_progress" : s.status,
				})),
			);
			return;
		}
		const item = p.item;
		if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") {
			const thinking = method.includes("reasoning");
			received.add(p.itemId);
			e.activity?.({ phase: thinking ? "thinking" : "writing" });
			e.delta(p.itemId, thinking ? "thinking" : "text", p.delta);
		} else if (item && (method === "item/started" || method === "item/completed")) {
			const completed = method === "item/completed";
			if (completed) items.delete(item.id);
			else items.set(item.id, item);
			if (["agentMessage", "reasoning", "plan"].includes(item.type)) {
				if (completed) {
					const text = item.text ?? item.summary?.join("\n");
					if (item.type === "agentMessage" && text) e.answer?.(text);
					if (!received.has(item.id) && text) e.delta(item.id, item.type === "reasoning" ? "thinking" : "text", text);
					e.end(item.id);
				}
				return;
			}
			const tool = toolDisplay(item, ctx.cwd, scratch, completed);
			if (tool) {
				if (
					completed &&
					tool.error &&
					!declined.has(item.id) &&
					/sandbox|operation not permitted|permission denied|read.only file system/i.test(item.aggregatedOutput ?? "")
				) {
					e.denied?.(tool.name, tool.detail || tool.name);
				}
				e.delta(item.id, "text", tool.block);
				e.end(item.id);
				e.activity?.(completed ? { phase: "thinking" } : { phase: "tool", tool: tool.name, detail: tool.detail });
				e.tool?.(completed ? { type: "end", isError: tool.error } : { type: "start", name: tool.name, detail: tool.detail });
			}
		}
	};
	try {
		await client.initialize();
		const { config: native } = await client.request("config/read", { cwd: ctx.cwd });
		const title = kind === "title";
		const servers = title
			? Object.fromEntries(Object.keys(native.mcp_servers ?? {}).map((name) => [name, { enabled: false }]))
			: mcpConfig(opts.pi, ctx, instance.id, native, opts.mode, kind === "super");
		const params: Fields = {
			cwd: ctx.cwd,
			...(opts.model !== "default" ? { model: opts.model } : {}),
			...modeParams(opts.mode),
			config: {
				mcp_servers: servers,
				project_doc_fallback_filenames: [...new Set([...(native.project_doc_fallback_filenames ?? []), "CLAUDE.md"])],
			},
		};
		if (title)
			Object.assign(params, {
				ephemeral: true,
				sandbox: "read-only",
				approvalPolicy: "never",
				environments: [],
				baseInstructions: opts.system,
			});
		else
			params.developerInstructions = [
				native.developer_instructions,
				"Your interface is pi. Show code in the chat unless asked to edit files. Use " +
					scratch +
					" for temporary files. Use the pi MCP tools when available for questions, wishes, watches and workflows.",
			]
				.filter(Boolean)
				.join("\n");
		let resumed = false;
		let started: Fields | undefined;
		if (!kind && scope === lastScope && lastThread && lastTurn) {
			try {
				const recent = await client.request("thread/turns/list", { threadId: lastThread, limit: 1, sortDirection: "desc" });
				if (recent.data?.[0]?.id === lastTurn) {
					started = await client.request("thread/resume", { ...params, threadId: lastThread, excludeTurns: true });
					resumed = true;
				}
			} catch (error) {
				if (!/not found|no rollout|unknown thread|not loaded|does not exist/i.test(String(error))) throw error;
			}
		}
		started ??= await client.request("thread/start", params);
		thread = started.thread.id;
		e.resolved?.(started.model);
		const collaborationMode =
			!title && opts.mode === "plan"
				? {
						mode: "plan",
						settings: { model: started.model, reasoning_effort: opts.effort ?? null, developer_instructions: null },
					}
				: undefined;
		const response = await client.request("turn/start", {
			threadId: thread,
			model: started.model,
			input: turnInput(messages, resumed),
			effort: opts.effort,
			summary: "auto",
			collaborationMode,
		});
		turn = response.turn.id;
		e.ready?.(async (text, images = []) => {
			await client.request("turn/steer", {
				threadId: thread,
				expectedTurnId: turn,
				input: blocks([{ type: "text", text }, ...images.map((i) => ({ type: "image" as const, ...i }))]),
			});
			const key = "steer-" + Date.now();
			e.delta(key, "text", "↳ You: " + (text || "[image]"));
			e.end(key);
		});
		const result = await Promise.race([done, client.stopped]);
		if (result instanceof Error) throw result;
		if (result.status !== "completed") throw new Error(result.error?.message || "Codex turn " + result.status);
		if (opts.park && !signal?.aborted) {
			parked = true;
			opts.park(client);
		}
		return { responseId: [scope, thread, turn].join("/"), thread };
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
		signal?.removeEventListener("abort", abort);
		if (!parked) {
			dialogs.abort();
			client.close();
		}
	}
}
