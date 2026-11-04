/**
 * The provider stream: runs one `agy -p` turn and translates its stream-json
 * output into pi assistant message events.
 *
 * agy prints one JSON object per line:
 *   {"event":"init","conversation_id":…,"init":{"model":…,"permission_mode":…}}
 *   {"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"…"}}
 *   {"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE|DONE|ERROR","step_type":"tool","tool_info":{…}}}
 *   {"event":"result","result":{"status":"SUCCESS","response":…,"usage":{…},"denied_actions":[…]}}
 * agy's stream-json events carry only thinking token counts, while its step
 * logger writes the full `thinking` text of each finished `agent_response` step
 * to `~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { diffBlock, diffStats, fileDiff } from "../shared/diff.ts";
import { truncate } from "../shared/format.ts";
import { codeSpan, displayPath, mcpTool, toolBlockHeader, toolCallBlock, toolResultBlock } from "../shared/tool-lines.ts";
import { spawnAgy, stopAgy, variantId } from "./cli.ts";
import { piMcpArgs } from "./mcp.ts";
import { AGY_DIR, DEFAULT_PROVIDER_ID, readJson, SESSIONS_FILE, writeJson } from "./config.ts";
import { ruleFromError } from "./permissions.ts";
import { type ContextUsage, type Denial, runtime } from "./state.ts";

// =============================================================================
// Session mapping: pi session -> agy conversation
// =============================================================================

interface SessionState {
	conversationId: string;
	cwd: string;
	/** Number of pi transcript messages already known to the agy conversation. */
	messageCount: number;
	context?: ContextUsage;
}

/** agy conversations belong to the account that held them, so the mapping is per instance. */
export function sessionKey(providerId: string, piSessionId: string): string {
	// The default instance keeps the plain key earlier versions wrote.
	return providerId === DEFAULT_PROVIDER_ID ? piSessionId : `${providerId}:${piSessionId}`;
}

export function loadSessions(): Record<string, SessionState> {
	return readJson<Record<string, SessionState>>(SESSIONS_FILE, {});
}

function saveSessions(sessions: Record<string, SessionState>): void {
	// Losing the mapping only means the next prompt replays the transcript.
	writeJson(SESSIONS_FILE, sessions);
}

/** Context usage of a session key, from memory or the sessions file. */
export function contextFor(key: string): ContextUsage | undefined {
	if (!runtime.context.has(key)) {
		const saved = loadSessions()[key]?.context;
		if (saved) runtime.context.set(key, saved);
	}
	return runtime.context.get(key);
}

/** Forgets the agy conversations of the given session keys; the next prompt starts new ones. */
export function forgetSessions(keys: string[]): void {
	const sessions = loadSessions();
	for (const key of keys) {
		delete sessions[key];
		runtime.context.delete(key);
	}
	saveSessions(sessions);
}

// =============================================================================
// Chat behaviour and scratch directory
// =============================================================================

/**
 * A per-session directory agy may write to, so throwaway files stay out of the
 * project. Its real path: agy checks permissions on resolved paths (/private/var/…
 * on macOS), and a workspace added as /var/… would not match.
 */
export function scratchDir(piSessionId: string | undefined): string {
	const base = process.env.PI_AGY_SCRATCH_DIR || join(tmpdir(), "pi-antigravity");
	const dir = join(base, (piSessionId ?? "default").replace(/[^A-Za-z0-9_-]/g, "_"));
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

/** agy has no flag for an extra system prompt, so these go in front of a new conversation's first message. */
function chatInstructions(scratch: string): string {
	return `<pi_instructions>
You are running inside pi, a terminal chat UI, through the Antigravity CLI. The user reads your replies as rendered Markdown.

- When the user asks for code, a snippet, an example, a script, a command or a config, put it in your reply as a fenced code block. Showing it in the chat is the default.
- The working directory is the user's project. Do not create new files there unless the user explicitly asks to add them to the project (for example "create X in the repo", "save it as X here", "add a test to the project"), or names a path inside it. Editing existing project files is fine when the task is to change them.
- Every other file you need to create — scripts or tests you write to try, run or demonstrate code, temporary files, intermediate outputs, downloads, experiments — goes into the scratch directory ${scratch}. It belongs to this session. When you put something there the user may want, mention its full path.
</pi_instructions>

`;
}

// =============================================================================
// Transcript helpers
// =============================================================================

function conversationMessages(context: TranscriptContext): Message[] {
	return (context.messages as any[]).filter((m) => m.role !== "system") as Message[];
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * agy takes no image attachments, but opens image files: an image of a message is
 * written into the scratch folder (named by its content, so once per image) and
 * the prompt names the file.
 */
export function imageFile(scratch: string, image: { data: string; mimeType: string }): string {
	const dir = join(scratch, "images");
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha256").update(image.data).digest("hex").slice(0, 16);
	const file = join(dir, `${hash}.${IMAGE_EXTENSIONS[image.mimeType.split(";")[0]!.trim()] ?? "png"}`);
	if (!existsSync(file)) writeFileSync(file, Buffer.from(image.data, "base64"));
	return file;
}

function messageText(msg: Message, scratch?: string): string {
	if (typeof (msg as any).content === "string") return (msg as any).content;
	return ((msg as any).content as any[])
		.map((c) => {
			// Tool blocks carry their output for the chat; the header line is enough here.
			if (c.type === "text") return /^[⏺⎿✗] /.test(c.text) ? toolBlockHeader(c.text) : c.text;
			if (c.type !== "image") return "";
			return scratch ? `[image attached as file: ${imageFile(scratch, c)} (open it to see it)]` : "[image]";
		})
		.filter(Boolean)
		.join("\n");
}

/** Serializes earlier pi messages so a new agy conversation knows the conversation so far. */
function transcriptPreamble(history: Message[], scratch: string): string {
	const lines = history
		.filter((m) => m.role === "user" || m.role === "assistant")
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m, scratch)}`)
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return "";
	return `<previous_conversation>\n${lines.join("\n\n")}\n</previous_conversation>\n\nContinue this conversation. The new message follows.\n\n`;
}

// =============================================================================
// Tools
// =============================================================================

/** agy's tool names as the other extensions know them (chat-crab's moods, the animation's verbs). */
const TOOL_NAMES: Record<string, string> = {
	run_command: "Bash",
	send_command_input: "Bash",
	command_status: "Bash",
	read_file: "Read",
	view_file: "Read",
	list_dir: "Glob",
	find_by_name: "Glob",
	grep_search: "Grep",
	write_file: "Write",
	write_to_file: "Write",
	replace_file_content: "Edit",
	multi_replace_file_content: "Edit",
	sed_file: "Edit",
	notebook_edit: "NotebookEdit",
	read_url_content: "WebFetch",
	read_browser_page: "WebFetch",
	open_browser_url: "WebFetch",
	search_web: "WebSearch",
	invoke_subagent: "Agent",
	browser_subagent: "Agent",
	manage_task: "TodoWrite",
};

/** Bookkeeping steps that are not shown. */
const QUIET_TOOLS = new Set(["finish", "wait", "wait_5_seconds", "list_permissions"]);

const EDIT_TOOLS = new Set(["write_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);

export const toolName = (name: string) => TOOL_NAMES[name] ?? name;

const DETAIL_KEYS = [
	"CommandLine",
	"Command",
	"Path",
	"AbsolutePath",
	"TargetFile",
	"File",
	"FilePath",
	"DirectoryPath",
	"SearchPath",
	"SearchDirectory",
	"Url",
	"URL",
	"Query",
	"Pattern",
	"Prompt",
	"Task",
];

/** What a tool works on, from its parameters: a command, a path, a URL, a query. */
export function toolDetail(parameters: unknown): string {
	if (!parameters || typeof parameters !== "object") return "";
	const p = parameters as Record<string, unknown>;
	const key = DETAIL_KEYS.find((k) => typeof p[k] === "string" && p[k]);
	const value = key ? p[key] : Object.values(p).find((v) => typeof v === "string" && v);
	return typeof value === "string" ? truncate(value, 160) : "";
}

/** agy's arguments under the names of Claude's tools, so the chat shows them alike; undefined for other tools. */
function claudeInput(raw: string, name: string, parameters: any): Record<string, unknown> | undefined {
	const p = parameters && typeof parameters === "object" ? parameters : {};
	if (mcpTool(raw)) return p;
	const path = p.AbsolutePath ?? p.Path ?? p.TargetFile ?? p.FilePath ?? p.File ?? p.DirectoryPath;
	switch (name) {
		case "Bash":
			return typeof (p.CommandLine ?? p.Command) === "string" ? { command: p.CommandLine ?? p.Command } : undefined;
		case "Read":
		case "Write":
		case "Edit":
			return typeof path === "string" ? { file_path: path } : undefined;
		case "Grep":
			return { pattern: p.Query ?? p.Pattern ?? "", path: p.SearchPath ?? p.SearchDirectory ?? path };
	}
	return undefined;
}

function editPath(parameters: any): string | undefined {
	const path = parameters?.Path ?? parameters?.TargetFile ?? parameters?.AbsolutePath ?? parameters?.FilePath ?? parameters?.File;
	return typeof path === "string" && isAbsolute(path) ? path : undefined;
}

function readText(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the `thinking` text of a finished `agent_response` step from agy's
 * conversation transcript (`transcript_full.jsonl`, or `transcript.jsonl`).
 */
export function readStepThinking(conversationId: string | undefined, stepIndex: number): string | undefined {
	if (!conversationId || typeof stepIndex !== "number") return undefined;
	const brain = process.env.PI_AGY_BRAIN_DIR || join(AGY_DIR, "brain");
	const logsDir = join(brain, conversationId, ".system_generated", "logs");
	const content = readText(join(logsDir, "transcript_full.jsonl")) ?? readText(join(logsDir, "transcript.jsonl"));
	if (!content) return undefined;
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.step_index === stepIndex && typeof entry.thinking === "string" && entry.thinking.trim()) {
				return entry.thinking.trim();
			}
		} catch {
			// Skip an incomplete trailing line.
		}
	}
	return undefined;
}

/** agy's error output without the machine-readable copy it appends ("AGY_ERROR: {…}"). */
export function errorText(stderr: string): string {
	return stderr.split(/^AGY_ERROR:/m)[0].trim();
}

// =============================================================================
// Streaming
// =============================================================================

export function streamAntigravity(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		let started = false;
		const start = () => {
			if (!started) {
				started = true;
				stream.push({ type: "start", partial: output });
			}
		};

		try {
			const instanceState = runtime.instances.get(model.provider);
			if (!instanceState) throw new Error(`No Antigravity CLI instance is configured for provider "${model.provider}"`);

			// Work out which messages the agy conversation has not seen yet.
			const messages = conversationMessages(context);
			const piSessionId = options?.sessionId ?? runtime.sessionId;
			const key = piSessionId ? sessionKey(model.provider, piSessionId) : undefined;
			const cwd = runtime.cwd;
			const scratch = scratchDir(piSessionId);
			const known = key ? loadSessions()[key] : undefined;
			const canResume =
				known !== undefined && known.cwd === cwd && known.messageCount <= messages.length && messages.length > 0;

			let lastAssistant = -1;
			messages.forEach((m, i) => {
				if (m.role === "assistant") lastAssistant = i;
			});
			const fresh = canResume ? messages.slice(known!.messageCount) : messages.slice(lastAssistant + 1);
			let prompt = fresh
				.filter((m) => m.role !== "assistant")
				.map((m) => messageText(m, scratch))
				.filter((text) => text.trim())
				.join("\n\n");
			if (!prompt) prompt = "Continue.";
			if (!canResume) prompt = chatInstructions(scratch) + transcriptPreamble(messages.slice(0, lastAssistant + 1), scratch) + prompt;

			const family = instanceState.models.find((m) => m.id === model.id);
			const level = model.reasoning ? (options?.reasoning as string | undefined) : undefined;
			const args = [
				`--print=${prompt}`,
				"--output-format",
				"stream-json",
				"--model",
				variantId(family, model.id, level),
				"--add-dir",
				scratch,
			];
			const mode = runtime.mode;
			if (mode === "bypass" || runtime.skipPermissionsOnce) args.push("--dangerously-skip-permissions");
			else if (mode !== "default") args.push("--mode", mode);
			if (canResume) args.push("--conversation", known!.conversationId);
			// After the bypass check above and before the reset: a bypassed run gets no gate.
			args.push(...piMcpArgs(instanceState.instance.command, false, model.provider));
			runtime.skipPermissionsOnce = false;
			const extra = process.env.PI_AGY_EXTRA_ARGS?.trim();
			if (extra) args.push(...extra.split(/\s+/));

			let payload: any = { command: instanceState.instance.command, args, cwd };
			const replaced = await options?.onPayload?.(payload, model);
			if (replaced !== undefined) payload = replaced;

			const child = spawnAgy(payload.command, payload.args, {
				cwd: payload.cwd,
				env: options?.env as Record<string, string> | undefined,
			});
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			// "exit", not "close": a background process agy starts can inherit stdout and keep the pipes open.
			const exited = new Promise<number | null>((resolve, reject) => {
				child.on("error", reject);
				child.on("exit", (code) => resolve(code));
			});

			const onAbort = () => {
				stopAgy(child, "SIGINT");
				setTimeout(() => stopAgy(child, "SIGKILL"), 3000).unref();
			};
			if (options?.signal?.aborted) onAbort();
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdin.on("error", () => {});
			child.stdin.end();

			/** What agy is doing, for the working animation; `liveChars` estimates the tokens of the step in progress. */
			const activity = {
				phase: "thinking" as "starting" | "thinking" | "writing" | "tool",
				tool: undefined as string | undefined,
				detail: undefined as string | undefined,
				doneTokens: 0,
				liveChars: 0,
			};
			const report = () =>
				runtime.onActivity?.(model.provider, {
					phase: activity.phase,
					tool: activity.tool,
					detail: activity.detail,
					tokens: activity.doneTokens + Math.round(activity.liveChars / 4),
				});
			report();

			const pushText = (text: string) => {
				start();
				output.content.push({ type: "text", text: "" });
				const idx = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
				(output.content[idx] as any).text = text;
				stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
			};

			/** The pi text block of each agent_response step that streams text. */
			const textBlocks = new Map<number, number>();
			const endText = (step: number) => {
				const idx = textBlocks.get(step);
				if (idx === undefined) return;
				textBlocks.delete(step);
				stream.push({ type: "text_end", contentIndex: idx, content: (output.content[idx] as any).text, partial: output });
			};
			/** The pi thinking block of each agent_response step, and where in `output.content` each step began. */
			const thinkingBlocks = new Map<number, number>();
			const stepPositions = new Map<number, number>();
			const seenThinking = new Set<number>();
			const endThinking = (step: number) => {
				const idx = thinkingBlocks.get(step);
				if (idx === undefined) return;
				thinkingBlocks.delete(step);
				seenThinking.add(step);
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: (output.content[idx] as any).thinking,
					partial: output,
				});
			};
			const pushThinking = (thinking: string, beforeIndex?: number) => {
				start();
				const block = { type: "thinking" as const, thinking: "" };
				let idx: number;
				if (beforeIndex !== undefined && beforeIndex <= output.content.length) {
					output.content.splice(beforeIndex, 0, block);
					idx = beforeIndex;
					for (const [k, v] of textBlocks) if (v >= beforeIndex) textBlocks.set(k, v + 1);
					for (const [k, v] of thinkingBlocks) if (v >= beforeIndex) thinkingBlocks.set(k, v + 1);
					for (const [k, v] of stepPositions) if (v >= beforeIndex) stepPositions.set(k, v + 1);
				} else {
					output.content.push(block);
					idx = output.content.length - 1;
				}
				stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
				block.thinking = thinking;
				stream.push({ type: "thinking_delta", contentIndex: idx, delta: thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex: idx, content: thinking, partial: output });
			};
			const emitStepThinking = (stepIndex: number, inlineThinking?: unknown) => {
				if (seenThinking.has(stepIndex)) return;
				const thinking =
					(typeof inlineThinking === "string" && inlineThinking.trim()) || readStepThinking(conversationId, stepIndex);
				if (!thinking) return;
				seenThinking.add(stepIndex);
				pushThinking(thinking, stepPositions.get(stepIndex));
			};
			/** Tool steps already announced, with the file content before an edit. */
			const tools = new Map<number, { name: string; raw: string; detail: string; quiet: boolean; before?: string; path?: string }>();
			const denials: Denial[] = [];
			let conversationId: string | undefined;
			let contextTokens: number | undefined;
			let streamedText = false;
			let result: any;

			const rl = createInterface({ input: child.stdout });
			// Stop reading shortly after agy exits, even if an inherited pipe stays open.
			void exited.finally(() => setTimeout(() => rl.close(), 2000).unref()).catch(() => {});
			for await (const line of rl) {
				if (!line.trim()) continue;
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				await options?.onProviderStreamEvent?.(msg, model);
				if (msg.conversation_id) conversationId = msg.conversation_id;
				if (conversationId && runtime.live?.conversationId !== conversationId) runtime.live = { key, conversationId };

				if (msg.event === "step_update") {
					const step = msg.step_update ?? {};
					const index: number = step.step_index;
					if (step.conversation_id) conversationId = step.conversation_id;

					if (step.step_type === "agent_response") {
						if (!stepPositions.has(index)) stepPositions.set(index, output.content.length);
						if (typeof step.thinking_delta === "string" && step.thinking_delta) {
							let idx = thinkingBlocks.get(index);
							if (idx === undefined) {
								start();
								output.content.push({ type: "thinking", thinking: "" });
								idx = output.content.length - 1;
								thinkingBlocks.set(index, idx);
								stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
							}
							(output.content[idx] as any).thinking += step.thinking_delta;
							stream.push({ type: "thinking_delta", contentIndex: idx, delta: step.thinking_delta, partial: output });
							activity.phase = "thinking";
							activity.liveChars += step.thinking_delta.length;
							report();
						}
						if (typeof step.text_delta === "string" && step.text_delta) {
							let idx = textBlocks.get(index);
							if (idx === undefined) {
								endThinking(index);
								start();
								output.content.push({ type: "text", text: "" });
								idx = output.content.length - 1;
								textBlocks.set(index, idx);
								stepPositions.set(index, idx);
								stream.push({ type: "text_start", contentIndex: idx, partial: output });
							}
							(output.content[idx] as any).text += step.text_delta;
							stream.push({ type: "text_delta", contentIndex: idx, delta: step.text_delta, partial: output });
							streamedText = true;
							activity.phase = "writing";
							activity.liveChars += step.text_delta.length;
							report();
						}
						if (step.state !== "ACTIVE") {
							endThinking(index);
							endText(index);
							emitStepThinking(index, step.thinking);
							const u = step.usage;
							if (u) {
								activity.doneTokens += (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
								const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
								contextTokens = tokens;
								if (key) {
									runtime.context.set(key, { tokens });
									runtime.onUsage?.();
								}
							}
							Object.assign(activity, { phase: "thinking", tool: undefined, detail: undefined, liveChars: 0 });
							report();
						}
					} else if (step.step_type === "tool") {
						const info = step.tool_info ?? {};
						const raw: string = step.tool_name ?? info.name ?? "tool";
						let tool = tools.get(index);
						if (!tool) {
							const path = EDIT_TOOLS.has(raw) ? editPath(info.parameters) : undefined;
							tool = { name: toolName(raw), raw, detail: toolDetail(info.parameters), quiet: QUIET_TOOLS.has(raw), path };
							if (path) tool.before = readText(path);
							tools.set(index, tool);
							Object.assign(activity, { phase: "tool", tool: tool.name, detail: tool.detail || undefined });
							report();
							if (!tool.quiet) {
								const input = claudeInput(raw, tool.name, info.parameters);
								pushText(toolCallBlock(mcpTool(raw) ? raw : tool.name, input ?? {}, cwd, input ? undefined : tool.detail));
								runtime.onTool?.({ type: "start", name: tool.name, detail: tool.detail || undefined });
							}
						}
						if (step.state === "DONE" || step.state === "ERROR") {
							const failed = step.state === "ERROR";
							Object.assign(activity, { phase: "thinking", tool: undefined, detail: undefined });
							report();
							if (failed) {
								const message: string = info.error?.message ?? "failed";
								const rule = ruleFromError(message);
								if (/user denied permission/.test(message)) {
									denials.push({ tool: tool.name, detail: tool.detail, rule, action: raw });
								}
							}
							if (tool.quiet && !failed) continue;
							runtime.onTool?.({ type: "end", isError: failed });
							const after = tool.path && !failed ? readText(tool.path) : undefined;
							const diff = tool.path && after !== undefined ? fileDiff(tool.before, after) : undefined;
							if (tool.path && diff) {
								const verb = tool.before === undefined ? "Created" : "Updated";
								const stats = diffStats(diff);
								pushText(`⎿ ${verb} ${codeSpan(displayPath(tool.path, cwd))}${stats ? ` (${stats})` : ""}\n\n${diffBlock(diff)}`);
							} else {
								const text = failed ? String(info.error?.message ?? "failed") : typeof info.output === "string" ? info.output : "";
								const read = tool.name === "Read" ? claudeInput(tool.raw, "Read", info.parameters)?.file_path : undefined;
								pushText(toolResultBlock(text, { isError: failed, file: typeof read === "string" ? { path: read } : undefined }));
							}
						}
					}
				} else if (msg.event === "result") {
					result = msg.result ?? {};
					if (result.conversation_id) conversationId = result.conversation_id;
					// The turn is complete; whatever agy prints after this is not needed.
					break;
				}
			}

			rl.close();
			child.stdout.destroy();
			// Don't let a straggler hold the turn.
			const straggler = setTimeout(() => stopAgy(child, "SIGTERM"), 5000);
			const code = await exited;
			clearTimeout(straggler);
			runtime.live = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
			runtime.onActivity?.(model.provider, undefined);
			for (const idx of [...thinkingBlocks.keys()]) endThinking(idx);
			for (const idx of [...textBlocks.keys()]) endText(idx);
			for (const stepIndex of stepPositions.keys()) emitStepThinking(stepIndex);

			if (options?.signal?.aborted) throw new Error("Request was aborted");

			if (conversationId && key) {
				const sessions = loadSessions();
				// The assistant reply produced here becomes one more transcript message.
				sessions[key] = {
					conversationId,
					cwd,
					messageCount: messages.length + 1,
					context: contextTokens !== undefined ? { tokens: contextTokens } : sessions[key]?.context,
				};
				saveSessions(sessions);
			}

			if (!result) {
				throw new Error(errorText(stderr) || `agy exited with code ${code} without a result`);
			}

			const usage = result.usage ?? {};
			output.usage.input = usage.input_tokens ?? 0;
			output.usage.output = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
			output.usage.cacheRead = usage.cache_read_tokens ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead;

			// Denied actions the steps did not name (e.g. without a tool step of their own).
			for (const action of result.denied_actions ?? []) {
				const name = String(action?.action ?? "");
				if (!denials.some((d) => d.action === name || (name === "command" && d.tool === "Bash"))) {
					denials.push({ tool: toolName(name) || String(action?.display_name ?? name), detail: "", action: name });
				}
			}
			runtime.denials = undefined;
			if (denials.length > 0) {
				runtime.denials = { mode, items: denials };
				const count = denials.length === 1 ? "1 action was" : `${denials.length} actions were`;
				pushText(
					[
						`> ⚠ **${count} not allowed** in mode \`${mode}\`:`,
						...denials.map((d) => `> - **${d.tool}**${d.detail ? ` ${codeSpan(d.detail)}` : ""}`),
					].join("\n"),
				);
			}

			if (result.status !== "SUCCESS") {
				throw new Error(
					(typeof result.response === "string" && result.response.trim()) ||
						errorText(stderr) ||
						`Antigravity finished with ${result.status ?? "an error"}`,
				);
			}
			// A response that came without streamed text.
			if (!streamedText && typeof result.response === "string" && result.response.trim()) pushText(result.response);

			start();
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			runtime.live = undefined;
			runtime.onActivity?.(model.provider, undefined);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}
