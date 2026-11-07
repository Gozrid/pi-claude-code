/**
 * The provider stream: runs one `claude -p` turn and translates its stream-json
 * output into pi assistant message events.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Task } from "../shared/agent-bus.ts";
import { diffBlock, diffStats } from "../shared/diff.ts";
import { truncate } from "../shared/format.ts";
import { type CliMcpServer, hiddenMcpTools, mcpConfigJson, ownMcp, piMcpServers, privateFile, viaProxy } from "../shared/pi-mcp.ts";
import { codeSpan, displayPath, saveToolImage, toolBlockHeader, toolCallBlock, toolResultBlock } from "../shared/tool-lines.ts";
import { spawnClaude, stopClaude, thinkingDisplayArgs } from "./cli.ts";
import { DEFAULT_PROVIDER_ID, readJson, SESSIONS_FILE, writeJson } from "./config.ts";
import { editDiff } from "./diff.ts";
import { type ContextUsage, type LiveRun, runtime } from "./state.ts";
import { applyTaskTool, TASK_TOOLS } from "./tasks.ts";
import { usageFromRateLimitEvent } from "./usage.ts";

// =============================================================================
// Session mapping: pi session -> Claude Code session, per instance
// =============================================================================

interface SessionState {
	claudeSessionId: string;
	cwd: string;
	/** Number of pi transcript messages already known to the Claude Code session. */
	messageCount: number;
	context?: ContextUsage;
	tasks?: Task[];
}

/** Claude sessions live in one instance's config dir, so the mapping is per instance. */
export function sessionKey(providerId: string, piSessionId: string): string {
	// The default instance keeps the plain key earlier versions wrote.
	return providerId === DEFAULT_PROVIDER_ID ? piSessionId : `${providerId}:${piSessionId}`;
}

export function loadSessions(): Record<string, SessionState> {
	return readJson<Record<string, SessionState>>(SESSIONS_FILE, {});
}

export function saveSessions(sessions: Record<string, SessionState>): void {
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

/** Claude's task list of a session key, from memory or the sessions file. */
export function tasksFor(key: string): Task[] {
	if (!runtime.tasks.has(key)) runtime.tasks.set(key, loadSessions()[key]?.tasks ?? []);
	return runtime.tasks.get(key)!;
}

/** Forgets what is known about these session keys (a fresh Claude Code session follows). */
export function forgetSessions(keys: string[]): void {
	const sessions = loadSessions();
	for (const key of keys) {
		delete sessions[key];
		runtime.context.delete(key);
		runtime.tasks.delete(key);
	}
	saveSessions(sessions);
}

// =============================================================================
// Chat behavior and scratch directory
// =============================================================================

/** A per-session directory Claude may write freely, so throwaway files stay out of the project. */
export function scratchDir(piSessionId: string | undefined): string {
	const base = process.env.PI_CLAUDE_SCRATCH_DIR || join(tmpdir(), "pi-claude-code");
	const dir = join(base, (piSessionId ?? "default").replace(/[^A-Za-z0-9_-]/g, "_"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * pi's MCP servers and only those (see shared/pi-mcp.ts), plus pi's own server
 * (pi-bridge) when it is on; the file keeps their credentials off the command
 * line. With pi-bridge, the servers come through pi's own connections and
 * show only the tools pi does not hide; without it, Claude starts them itself
 * and the tools pi hides are disallowed. When pi can answer permission
 * prompts, Claude asks it instead of denying what its mode does not allow.
 */
export function piMcpArgs(provider = "", command = "claude"): string[] {
	const bridge = runtime.bridge?.(provider, command);
	const own: Record<string, CliMcpServer> = bridge ? { [bridge.name]: { type: "http", url: bridge.url, headers: bridge.headers } } : {};
	const permission = bridge?.permissionTool
		? ["--permission-prompts", "host", "--permission-prompt-tool", bridge.permissionTool]
		: ["--permission-prompts", "none"];
	if (ownMcp()) {
		// Claude keeps its own servers; pi's server comes on top.
		return [...permission, ...(bridge ? ["--mcp-config", privateFile("claude-mcp", mcpConfigJson(own))] : [])];
	}
	const { servers } = piMcpServers({ agentDir: getAgentDir(), cwd: runtime.cwd, projectTrusted: runtime.projectTrusted });
	const proxy = bridge?.mcpUrl ? { url: (name: string) => `${bridge.mcpUrl}/${encodeURIComponent(name)}`, headers: bridge.headers } : undefined;
	const hidden = proxy ? [] : hiddenMcpTools(runtime.piTools?.() ?? [], Object.keys(servers));
	return [
		...permission,
		"--strict-mcp-config",
		"--mcp-config",
		privateFile("claude-mcp", mcpConfigJson({ ...viaProxy(servers, proxy), ...own })),
		...(hidden.length > 0 ? ["--disallowedTools", hidden.map((t) => `mcp__${t.server}__${t.tool}`).join(",")] : []),
	];
}

function chatInstructions(scratch: string): string {
	return `You are running inside pi, a terminal chat UI, through the Claude Code CLI. The user reads your replies as rendered Markdown.

- When the user asks for code, a snippet, an example, a script, a command or a config, put it in your reply as a fenced code block. Showing it in the chat is the default.
- The working directory is the user's project. Do not create new files there unless the user explicitly asks to add them to the project (for example "create X in the repo", "save it as X here", "add a test to the project"), or names a path inside it. Editing existing project files is fine when the task is to change them.
- Every other file you need to create — scripts or tests you write to try, run or demonstrate code, temporary files, intermediate outputs, downloads, experiments — goes into the scratch directory ${scratch}. It belongs to this session and you can write there without asking. When you put something there the user may want, mention its full path.`;
}

// =============================================================================
// Transcript helpers
// =============================================================================

type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function conversationMessages(context: TranscriptContext): Message[] {
	return (context.messages as any[]).filter((m) => m.role !== "system") as Message[];
}

function messageText(msg: Message): string {
	if (typeof (msg as any).content === "string") return (msg as any).content;
	// Tool blocks carry their output for the chat; the header line is enough here.
	return ((msg as any).content as any[])
		.map((c) => (c.type === "text" ? (/^[⏺⎿✗] /.test(c.text) ? toolBlockHeader(c.text) : c.text) : c.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function toClaudeBlocks(msg: Message): ClaudeContentBlock[] {
	const content = (msg as any).content;
	if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
	const blocks: ClaudeContentBlock[] = [];
	for (const c of content as any[]) {
		if (c.type === "text" && c.text.trim()) blocks.push({ type: "text", text: c.text });
		else if (c.type === "image")
			blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
	}
	return blocks;
}

/** Serializes earlier pi messages so a fresh Claude Code session knows the conversation so far. */
function transcriptPreamble(history: Message[]): string {
	const lines = history
		.filter((m) => m.role === "user" || m.role === "assistant")
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m)}`)
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return "";
	return `<previous_conversation>\n${lines.join("\n\n")}\n</previous_conversation>\n\nContinue this conversation. The new message follows.\n\n`;
}

// =============================================================================
// Tool activity formatting
// =============================================================================

export function summarizeToolInput(input: any): string {
	if (!input || typeof input !== "object") return "";
	const pick =
		input.command ??
		input.file_path ??
		input.notebook_path ??
		input.pattern ??
		input.url ??
		input.query ??
		input.description ??
		input.prompt;
	if (typeof pick === "string") return truncate(pick, 160);
	const json = JSON.stringify(input);
	return json === "{}" ? "" : truncate(json, 160);
}

export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((c: any) => c.type !== "image")
			.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
			.join("\n");
	return "";
}

/** The images of a tool result, saved in `dir` for the chat to show. */
function toolResultImages(content: unknown, dir: string): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((c: any) => c.type === "image" && c.source?.type === "base64" && typeof c.source.data === "string")
		.map((c: any) => saveToolImage(dir, c.source.data, c.source.media_type ?? "image/png"))
		.filter((p): p is string => !!p);
}

/** Tools whose calls are not shown in the chat. */
const QUIET_TOOLS = new Set([...TASK_TOOLS, "TaskGet", "TaskList", "ToolSearch"]);

/** The main model's context window from a result's per-model usage (the model that read the most). */
function contextWindowOf(result: any): number | undefined {
	const models = Object.values(result?.modelUsage ?? {}) as any[];
	const read = (m: any) => (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
	const main = models.sort((a, b) => read(b) - read(a))[0];
	return typeof main?.contextWindow === "number" ? main.contextWindow : undefined;
}

// =============================================================================
// Steering
// =============================================================================
//
// pi hands steering to a model between its turns, but claude runs a whole
// answer with all its tool calls as one pi turn, so a steer would only arrive
// once claude is done. Instead, claude's input stays open while it works: a
// steer goes into it at once (steerRun, from the extension's input handler) and
// claude takes it up after its current step. pi still queues the steer too.
// When claude echoes it back (--replay-user-messages), the answer so far ends
// as one pi message; pi then delivers its queued steer as the next user
// message, and the turn that answers it continues reading the same claude
// process instead of starting a new one. A steer that comes while claude
// writes its final answer is taken up as a new claude turn after the result;
// the answer is split at the result then.
//
// claude also echoes the prompt a new process starts with. Only a result after
// that echo ends the turn: when resumed, claude may first report a result of
// its own, e.g. a background task the last run left behind was stopped.

/** The text of a pi user message, as it was steered. */
function userText(msg: Message): string {
	const content = (msg as any).content;
	if (typeof content === "string") return content.trim();
	return (content as any[])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

/** Whether a user message from claude carries tool results (not text the user wrote). */
function isToolResults(msg: any): boolean {
	const content = msg.message?.content;
	return Array.isArray(content) && content.some((c: any) => c.type === "tool_result");
}

/** A user message for claude's input. */
function userInput(content: ClaudeContentBlock[]): string {
	return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/**
 * Sends a steer into the running claude process, if there is one that still
 * takes input. Returns whether it went out; pi queues it either way.
 */
export function steerRun(text: string, images: { data: string; mimeType: string }[] = []): boolean {
	const live = runtime.live;
	const trimmed = text.trim();
	if (!live || live.closing || live.detached || !trimmed) return false;
	const content: ClaudeContentBlock[] = [
		{ type: "text", text: trimmed },
		...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType, data: i.data } })),
	];
	try {
		live.child.stdin.write(userInput(content));
	} catch {
		return false;
	}
	live.waiting.push(trimmed);
	live.steers.add(trimmed);
	return true;
}

/** Stops a claude process kept for a steer that pi did not deliver (e.g. taken back into the editor). */
export function dropLiveRun(): void {
	const live = runtime.live;
	if (!live || !live.detached) return;
	runtime.live = undefined;
	stopLive(live);
}

/** Stops the kept claude process, whatever it is kept for (session ends, /claude-new). */
export function stopLiveRun(options: { report?: boolean } = {}): void {
	const live = runtime.live;
	if (!live) return;
	runtime.live = undefined;
	stopLive(live, options);
}

/** Asks claude to stop its current step, as Escape does in Claude Code; tools in flight end as cancelled. */
function interrupt(live: LiveRun): void {
	controlRequest(live, { subtype: "interrupt" });
}

function controlRequest(live: LiveRun, request: Record<string, unknown>): void {
	try {
		live.child.stdin.write(
			`${JSON.stringify({ type: "control_request", request_id: `pi-${request.subtype}-${Date.now()}`, request })}\n`,
		);
	} catch {}
}

/**
 * Ends a claude process: first its current step (cleanly, not killed), then its
 * input; signals only follow when it does not end by itself. Its background
 * tasks end with it; pi says so in the chat (unless `report` is false).
 */
function stopLive(live: LiveRun, { report = true }: { report?: boolean } = {}): void {
	if (live.idleTimer) clearTimeout(live.idleTimer);
	const stopped = [...live.tasks.values()];
	live.tasks.clear();
	live.closing = true;
	interrupt(live);
	try {
		live.child.stdin.end();
	} catch {}
	// With its input closed claude still waits for its background tasks; these end now.
	setTimeout(() => stopClaude(live.child, "SIGTERM"), stopped.length > 0 ? 1000 : 3000).unref();
	setTimeout(() => stopClaude(live.child, "SIGKILL"), 8000).unref();
	if (report && stopped.length > 0) runtime.onTasksStopped?.(stopped);
}

// =============================================================================
// Background tasks
// =============================================================================
//
// claude's background tasks (shell commands with run_in_background, background
// subagents, monitors) live in its process. While some run, the process stays
// after the turn's result with its input open ("idle"), and the next prompt
// goes into it instead of a new claude. When a task ends, claude starts a turn
// on its own; pi is asked for a turn that shows it (runtime.onWake) and that
// turn reads on without sending anything. A claude whose tasks are all done
// ends after that turn, or after IDLE_GRACE_MS if it starts none.
//
// A claude that has to go anyway (another model provider, session or launch
// setting, /claude-new, pi closing) is stopped cleanly; its tasks end with it
// and pi says so in the chat (runtime.onTasksStopped).

/** How long an idle claude whose background tasks are all done may take to start its turn about them. */
const IDLE_GRACE_MS = 10_000;

/** How long claude may take to end its step after Escape before it is signalled. */
const ABORT_GRACE_MS = 5000;

/** Follows claude's background tasks, and notices when an idle claude starts a turn on its own. */
function observe(live: LiveRun, line: string): void {
	if (!live.idle && !line.includes("background_tasks_changed")) return;
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type === "system" && msg.subtype === "background_tasks_changed" && Array.isArray(msg.tasks)) {
		live.tasks = new Map(
			msg.tasks.map((t: any) => [String(t.task_id), String(t.description || t.task_type || t.task_id)] as [string, string]),
		);
	}
	if (!live.idle || live.woke || live.closing) return;
	if (msg.type === "system" && msg.subtype === "task_notification") {
		if (typeof msg.summary === "string" && msg.summary.trim()) live.notices.push(msg.summary.trim());
	} else if (
		msg.type === "stream_event" ||
		msg.type === "assistant" ||
		(msg.type === "system" && msg.subtype === "init")
	) {
		live.woke = true;
		if (live.idleTimer) clearTimeout(live.idleTimer);
		live.idleTimer = undefined;
		const text = live.notices.length > 0 ? live.notices.join("\n") : "A background task of Claude Code ended.";
		live.notices = [];
		live.wakeTexts.add(text);
		runtime.onWake?.(live.provider, text);
		return;
	}
	scheduleIdleEnd(live);
}

/** An idle claude with no background tasks left gets a moment to start its turn about them, then ends. */
function scheduleIdleEnd(live: LiveRun): void {
	if (!live.idle || live.woke || live.tasks.size > 0 || live.idleTimer) return;
	live.idleTimer = setTimeout(() => {
		live.idleTimer = undefined;
		if (runtime.live === live && live.idle && !live.woke && live.tasks.size === 0) stopLiveRun();
	}, IDLE_GRACE_MS);
	live.idleTimer.unref?.();
}

/** The turn is over but background tasks run on: claude stays, idle, for them and the next prompt. */
function keepIdle(live: LiveRun): void {
	live.idle = true;
	live.woke = false;
	live.notices = [];
	// Lines that came after the result were seen while the turn still read; look at them again.
	for (const line of [...live.buffer]) observe(live, line);
	scheduleIdleEnd(live);
}

/** stdout lines of claude, queued until a turn reads them; `observe` sees each at once. */
function lineReader(live: () => LiveRun | undefined, rl: ReturnType<typeof createInterface>, buffer: string[]) {
	let waiter: ((r: IteratorResult<string>) => void) | undefined;
	let done = false;
	rl.on("line", (line) => {
		const run = live();
		if (run) observe(run, line);
		if (waiter) {
			const w = waiter;
			waiter = undefined;
			w({ value: line, done: false });
		} else buffer.push(line);
	});
	rl.on("close", () => {
		done = true;
		waiter?.({ value: undefined, done: true });
		waiter = undefined;
	});
	const lines: AsyncIterator<string> = {
		next: () => {
			if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
			if (done) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
		return: async () => {
			rl.close();
			buffer.length = 0;
			return { value: undefined, done: true };
		},
	};
	return lines;
}

/**
 * The CLI arguments a running claude keeps: all but the model and the permission
 * mode, which change through control requests, and the session it resumed.
 */
function launchSignature(args: string[]): string {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (["--model", "--permission-mode", "--resume"].includes(args[i])) i++;
		else kept.push(args[i]);
	}
	return JSON.stringify(kept);
}

// =============================================================================
// Streaming
// =============================================================================

function effortFor(model: Model<Api>, level: string | undefined): string | undefined {
	if (!level || level === "off" || !model.reasoning) return undefined;
	const mapped = (model as any).thinkingLevelMap?.[level];
	if (mapped === null) return undefined;
	return mapped ?? (level === "minimal" ? "low" : level);
}

export function streamClaudeCode(
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
		/** The claude process this turn reads, to stop it when the turn fails. */
		let owned: LiveRun | undefined;
		let started = false;
		const start = () => {
			if (!started) {
				started = true;
				stream.push({ type: "start", partial: output });
			}
		};

		try {
			const instanceState = runtime.instances.get(model.provider);
			if (!instanceState) throw new Error(`No Claude CLI instance is configured for provider "${model.provider}"`);

			// Work out which messages Claude Code has not seen yet.
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
			const pending = messages.slice(lastAssistant + 1);
			const newBlocks: ClaudeContentBlock[] = [];
			for (const m of canResume ? messages.slice(known!.messageCount) : pending) {
				if (m.role === "user" || m.role === "toolResult") newBlocks.push(...toClaudeBlocks(m));
				else if (m.role !== "assistant") {
					const text = messageText(m);
					if (text.trim()) newBlocks.push({ type: "text", text });
				}
			}
			if (!canResume) {
				const preamble = transcriptPreamble(messages.slice(0, lastAssistant + 1));
				if (preamble) newBlocks.unshift({ type: "text", text: preamble });
			}
			if (newBlocks.length === 0) newBlocks.push({ type: "text", text: "Continue." });

			// A steer split the last answer: this turn answers it by reading on in the same claude process.
			const steered = pending.filter((m) => m.role === "user").map(userText);
			const args = [
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				// Echoes steers when claude takes them up (see "Steering").
				"--replay-user-messages",
				"--model",
				model.id,
				"--permission-mode",
				runtime.permissionMode,
				...thinkingDisplayArgs(instanceState),
				"--add-dir",
				scratch,
				"--append-system-prompt",
				chatInstructions(scratch),
			];
			const effort = effortFor(model, options?.reasoning as string | undefined);
			if (effort) args.push("--effort", effort);
			if (canResume) args.push("--resume", known!.claudeSessionId);
			const mcpArgs = piMcpArgs(model.provider, instanceState.instance.command);
			// The user answers permission prompts in pi itself; what they deny needs no retry offer.
			const userDecides = mcpArgs.includes("--permission-prompt-tool");
			args.push(...mcpArgs);
			// Tools the user allowed once after a denial.
			const allowOnce = runtime.allowOnce;
			runtime.allowOnce = undefined;
			if (allowOnce?.length) args.push("--allowedTools", allowOnce.join(","));
			const extra = process.env.PI_CLAUDE_EXTRA_ARGS?.trim();
			if (extra) args.push(...extra.split(/\s+/));

			// The claude kept from the last turn: read on in it (a steer split the answer, or it started a
			// turn on its own), send it this turn's prompt (idle with background tasks), or stop it.
			let live = runtime.live;
			const sameRun =
				live !== undefined &&
				!live.closing &&
				live.provider === model.provider &&
				live.key === key &&
				live.child.exitCode === null &&
				live.child.signalCode === null;
			let reuse: "read" | "send" | undefined;
			if (sameRun && live!.detached && steered.length > 0 && steered.every((t) => live!.steers.has(t))) reuse = "read";
			else if (sameRun && live!.idle && live!.woke && steered.length > 0 && steered.every((t) => live!.wakeTexts.has(t)))
				reuse = "read";
			else if (
				sameRun &&
				live!.idle &&
				canResume &&
				known!.claudeSessionId === live!.claudeSessionId &&
				live!.signature === launchSignature(args)
			)
				reuse = "send";
			if (live && !reuse) {
				runtime.live = undefined;
				stopLive(live);
				live = undefined;
			}
			/** Steers this turn answers; claude's echo of them is no reason to split again. */
			const expected = new Set(live?.detached ? steered : []);
			if (live && reuse === "send") {
				if (live.model !== model.id) controlRequest(live, { subtype: "set_model", model: model.id });
				if (live.mode !== runtime.permissionMode)
					controlRequest(live, { subtype: "set_permission_mode", mode: runtime.permissionMode });
				live.model = model.id;
				live.mode = runtime.permissionMode;
				live.child.stdin.write(userInput(newBlocks));
			}
			if (live) {
				if (live.idleTimer) clearTimeout(live.idleTimer);
				live.idleTimer = undefined;
				live.idle = false;
				live.woke = false;
				live.wakeTexts.clear();
			}

			/**
			 * Whether claude has taken up this turn's input. A claude that reads on has it already; a new
			 * one may first report a result of its own, e.g. for a background task the last run left
			 * stopped, before it echoes the prompt (see "Steering").
			 */
			let inputTaken = reuse === "read";
			if (!live) {
				let payload: any = {
					command: instanceState.instance.command,
					args,
					cwd,
					input: { type: "user", message: { role: "user", content: newBlocks } },
				};
				const replaced = await options?.onPayload?.(payload, model);
				if (replaced !== undefined) payload = replaced;

				// Print mode leaves Claude's task tools off; the task list above the editor needs them.
				const taskEnv: Record<string, string> =
					process.env.PI_CLAUDE_TASKS === "0" ? {} : { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" };
				const spawned = spawnClaude(instanceState.instance, payload.args, {
					cwd: payload.cwd,
					env: { ...taskEnv, ...(options?.env as Record<string, string> | undefined) },
				});
				// "exit", not "close": a background process claude starts (e.g. its daemon) can inherit
				// stdout and keep the pipes open long after claude itself is done.
				const exited = new Promise<number | null>((resolve, reject) => {
					spawned.on("error", reject);
					spawned.on("exit", (code) => resolve(code));
				});
				const rl = createInterface({ input: spawned.stdout });
				// Stop reading shortly after claude exits, even if an inherited pipe stays open.
				void exited.finally(() => setTimeout(() => rl.close(), 2000).unref()).catch(() => {});
				const buffer: string[] = [];
				const started: LiveRun = {
					provider: model.provider,
					key,
					child: spawned,
					lines: lineReader(() => started, rl, buffer),
					buffer,
					signature: launchSignature(payload.args),
					model: model.id,
					mode: runtime.permissionMode,
					tasks: new Map(),
					idle: false,
					woke: false,
					notices: [],
					wakeTexts: new Set(),
					exited,
					stderr: "",
					waiting: [],
					steers: new Set(),
					detached: false,
					closing: false,
				};
				// A kept claude that ends by itself (not stopped by pi) while its background tasks run.
				void exited
					.then(() => {
						if (started.closing) return;
						if (started.idleTimer) clearTimeout(started.idleTimer);
						const stopped = [...started.tasks.values()];
						started.tasks.clear();
						if (runtime.live === started && started.idle) {
							runtime.live = undefined;
							if (stopped.length > 0) runtime.onTasksStopped?.(stopped);
						}
					})
					.catch(() => {});
				spawned.stderr.on("data", (d) => {
					started.stderr += d.toString();
				});
				spawned.stdin.on("error", () => {});
				// The input stays open for steers until the final result.
				spawned.stdin.write(`${JSON.stringify(payload.input)}\n`);
				live = started;
				runtime.live = live;
			}
			live.detached = false;
			const run = live;
			owned = run;
			const child = run.child;

			// Escape stops claude's current step the way Claude Code does, so tools in flight end as
			// cancelled and background tasks run on. Only a claude that does not answer is signalled.
			let abortTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				interrupt(run);
				abortTimer = setTimeout(() => {
					stopClaude(child, "SIGINT");
					setTimeout(() => stopClaude(child, "SIGKILL"), 3000).unref();
				}, ABORT_GRACE_MS);
				abortTimer.unref?.();
			};
			if (options?.signal?.aborted) onAbort();
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			/** What claude is doing, for the working animation; `liveChars` estimates the tokens of the message in progress. */
			const activity = {
				phase: "starting" as "starting" | "thinking" | "writing" | "tool",
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

			// Maps content block indexes of the current API message to pi content indexes.
			let blockMap = new Map<number, number>();
			const toolInputs = new Map<number, { id: string; name: string; json: string }>();
			let messageOutputTokens = 0;
			let claudeSessionId = run.claudeSessionId;
			let result: any;
			/** The answer ends here for a steer; claude keeps running for the next turn. */
			let split = false;
			/** Finished tool calls by id, to pair them with their results. */
			const toolCalls = new Map<string, { name: string; input: any }>();
			/** The last call shown; a result after another call names its tool. */
			let lastCall: string | undefined;
			/** Context size after the latest API call: its input (incl. cache) plus its output. */
			let contextTokens = run.contextTokens;
			let tasks = key ? tasksFor(key) : [];

			const pushText = (text: string) => {
				start();
				output.content.push({ type: "text", text: "" });
				const idx = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
				(output.content[idx] as any).text = text;
				stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
			};

			while (true) {
				const next = await run.lines.next();
				if (next.done) break;
				const line = next.value;
				if (!line.trim()) continue;
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				await options?.onProviderStreamEvent?.(msg, model);
				if (msg.session_id) {
					claudeSessionId = msg.session_id;
					// Known from the first line on, so the subagents of a first run are found while it runs.
					run.claudeSessionId = claudeSessionId;
				}
				if (msg.type === "rate_limit_event") {
					instanceState.usage = usageFromRateLimitEvent(msg.rate_limit_info, instanceState.usage);
					runtime.onUsage?.();
					continue;
				}
				// Subagent traffic is summarized by its parent Task/Agent tool call.
				if (msg.parent_tool_use_id) continue;

				// claude took up a steer: the answer so far ends, pi delivers the steer and the next turn reads on.
				if (msg.type === "user" && msg.isReplay && !isToolResults(msg)) {
					const text = userText(msg.message ?? { content: "" });
					const at = run.waiting.indexOf(text);
					if (at < 0) {
						// What a control request prints (e.g. a model change) is not the prompt.
						if (text.startsWith("<local-command-stdout>")) continue;
						// Not a steer: the echo of this turn's prompt.
						inputTaken = true;
						continue;
					}
					run.waiting.splice(at, 1);
					if (expected.delete(text)) continue;
					split = true;
					break;
				}

				if (msg.type === "stream_event") {
					const ev = msg.event;
					switch (ev.type) {
						case "message_start": {
							blockMap = new Map();
							toolInputs.clear();
							const u = ev.message?.usage ?? {};
							output.usage.input = u.input_tokens ?? 0;
							output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
							// message_delta reports the message's running total, which includes these.
							messageOutputTokens = u.output_tokens ?? 0;
							output.usage.output += messageOutputTokens;
							contextTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite + messageOutputTokens;
							// Each API call of a run reports the context so far; show it live, not only after the run.
							if (key) {
								const window = instanceState.instance.contextWindow ?? contextFor(key)?.window ?? model.contextWindow;
								runtime.context.set(key, { tokens: contextTokens, window });
								runtime.onUsage?.();
							}
							activity.liveChars = 0;
							report();
							break;
						}
						case "content_block_start": {
							const block = ev.content_block;
							if (block.type === "text") {
								activity.phase = "writing";
								start();
								output.content.push({ type: "text", text: "" });
								blockMap.set(ev.index, output.content.length - 1);
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							} else if (block.type === "thinking") {
								activity.phase = "thinking";
								start();
								output.content.push({ type: "thinking", thinking: "" });
								blockMap.set(ev.index, output.content.length - 1);
								stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
							} else if (block.type === "tool_use" || block.type === "server_tool_use") {
								toolInputs.set(ev.index, { id: block.id, name: block.name, json: "" });
								Object.assign(activity, { phase: "tool", tool: block.name, detail: undefined });
							}
							report();
							break;
						}
						case "content_block_delta": {
							const idx = blockMap.get(ev.index);
							const d = ev.delta;
							activity.liveChars += (d.text ?? d.thinking ?? d.partial_json ?? "").length;
							report();
							if (d.type === "text_delta" && idx !== undefined) {
								(output.content[idx] as any).text += d.text;
								stream.push({ type: "text_delta", contentIndex: idx, delta: d.text, partial: output });
							} else if (d.type === "thinking_delta" && idx !== undefined) {
								(output.content[idx] as any).thinking += d.thinking;
								stream.push({ type: "thinking_delta", contentIndex: idx, delta: d.thinking, partial: output });
							} else if (d.type === "input_json_delta") {
								const tool = toolInputs.get(ev.index);
								if (tool) tool.json += d.partial_json;
							}
							break;
						}
						case "content_block_stop": {
							const idx = blockMap.get(ev.index);
							if (idx !== undefined) {
								const block = output.content[idx] as any;
								if (block.type === "text")
									stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
								else
									stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
							}
							const tool = toolInputs.get(ev.index);
							if (tool) {
								let input: unknown = {};
								try {
									input = tool.json ? JSON.parse(tool.json) : {};
								} catch {}
								const summary = summarizeToolInput(input);
								activity.detail = summary;
								report();
								toolCalls.set(tool.id, { name: tool.name, input });
								// Task tools show up in the task list; tool search is bookkeeping.
								if (!QUIET_TOOLS.has(tool.name)) {
									pushText(toolCallBlock(tool.name, input, cwd));
									lastCall = tool.id;
									runtime.onTool?.({ type: "start", name: tool.name, detail: summary || undefined });
								}
							}
							break;
						}
						case "message_delta": {
							const out = ev.usage?.output_tokens;
							if (typeof out === "number") {
								output.usage.output += out - messageOutputTokens;
								if (contextTokens !== undefined) contextTokens += out - messageOutputTokens;
								messageOutputTokens = out;
								activity.doneTokens = output.usage.output;
								activity.liveChars = 0;
								report();
							}
							break;
						}
					}
				} else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
					const results = msg.message.content.filter((c: any) => c.type === "tool_result");
					for (const c of results) {
						Object.assign(activity, { phase: "starting", tool: undefined, detail: undefined });
						report();
						const call = toolCalls.get(c.tool_use_id);
						// The structured result belongs to the message's only tool result.
						const structured = results.length === 1 ? msg.tool_use_result : undefined;
						if (call && !c.is_error && TASK_TOOLS.has(call.name)) {
							tasks = applyTaskTool(tasks, call.name, call.input, structured) ?? tasks;
							if (key) runtime.tasks.set(key, tasks);
							runtime.onTasks?.();
						}
						if (call && QUIET_TOOLS.has(call.name) && !c.is_error) continue;
						runtime.onTool?.({ type: "end", isError: !!c.is_error });
						const diff = call && !c.is_error ? editDiff(call.name, call.input, structured) : undefined;
						if (call && diff) {
							const file = displayPath(String(call.input?.file_path ?? call.input?.notebook_path ?? ""), cwd);
							const verb = structured?.type === "create" ? "Created" : "Updated";
							const stats = diffStats(diff);
							pushText(`⎿ ${verb} ${codeSpan(file)}${stats ? ` (${stats})` : ""}\n\n${diffBlock(diff)}`);
						} else {
							// A file Claude read shows highlighted, with its own line numbers.
							const read = call?.name === "Read" ? call.input : undefined;
							const file = read && structured?.type === "text" ? structured.file : undefined;
							pushText(
								toolResultBlock(typeof file?.content === "string" ? file.content : toolResultText(c.content), {
									isError: !!c.is_error,
									name: call && c.tool_use_id !== lastCall ? call.name : undefined,
									file: read ? { path: String(file?.filePath ?? read.file_path ?? ""), startLine: Number(file?.startLine) || undefined } : undefined,
									images: toolResultImages(c.content, scratch),
								}),
							);
						}
					}
				} else if (msg.type === "result") {
					// A result before claude took up the prompt is not this turn's answer.
					if (!inputTaken && !options?.signal?.aborted) continue;
					result = msg;
					// A steer claude has not taken up yet starts its next turn; the answer ends here.
					if (run.waiting.length > 0 && !options?.signal?.aborted) split = true;
					break;
				}
			}

			options?.signal?.removeEventListener("abort", onAbort);
			if (abortTimer) clearTimeout(abortTimer);
			runtime.onActivity?.(model.provider, undefined);
			run.claudeSessionId = claudeSessionId;
			run.contextTokens = contextTokens;
			let code: number | null = null;
			if (split) run.detached = true;
			else if (result && run.tasks.size > 0 && run.child.exitCode === null && run.child.signalCode === null) {
				// Background tasks run on in this claude; it stays for them and for the next prompt.
				keepIdle(run);
			} else {
				// The turn is complete; whatever claude prints after this is not needed.
				if (runtime.live === run) runtime.live = undefined;
				run.closing = true;
				child.stdin.end();
				await run.lines.return?.();
				child.stdout.destroy();
				// claude normally exits about a second after its result; don't let a straggler hold the turn.
				const straggler = setTimeout(() => stopClaude(child, "SIGTERM"), 5000);
				code = await run.exited;
				clearTimeout(straggler);
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");

			const contextUsage =
				contextTokens !== undefined
					? {
							tokens: contextTokens,
							// A configured window wins: Claude Code reports 1M for every plan.
							window:
								instanceState.instance.contextWindow ??
								contextWindowOf(result) ??
								(key ? runtime.context.get(key)?.window : undefined),
						}
					: undefined;
			if (key && contextUsage) runtime.context.set(key, contextUsage);
			if (claudeSessionId && key) {
				const sessions = loadSessions();
				// The assistant reply produced here becomes one more transcript message.
				sessions[key] = {
					claudeSessionId,
					cwd,
					messageCount: messages.length + 1,
					context: contextUsage ?? sessions[key]?.context,
					tasks,
				};
				saveSessions(sessions);
			}

			if (split && !result) {
				// Split before claude's result: the steer comes next, the result with the turn that reads on.
				start();
				output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			if (!result) {
				throw new Error(run.stderr.trim() || `claude exited with code ${code} without a result`);
			}

			if (typeof result.total_cost_usd === "number") output.usage.cost.total = result.total_cost_usd;
			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;

			// In plan mode Claude asks to leave it via ExitPlanMode; that request is expected to go unanswered.
			const denials: any[] = userDecides
				? []
				: (result.permission_denials ?? []).filter((d: any) => d.tool_name !== "ExitPlanMode");
			runtime.denials = undefined;
			if (denials.length > 0) {
				const items = denials.map((d) => ({ tool: String(d.tool_name), detail: summarizeToolInput(d.tool_input) }));
				runtime.denials = { mode: runtime.permissionMode, items };
				const count = items.length === 1 ? "1 action was" : `${items.length} actions were`;
				pushText(
					[
						`> ⚠ **${count} not allowed** in mode \`${runtime.permissionMode}\`:`,
						...items.map((item) => `> - **${item.tool}**${item.detail ? ` ${codeSpan(item.detail)}` : ""}`),
					].join("\n"),
				);
			}

			if (result.is_error || result.subtype !== "success") {
				throw new Error(
					(typeof result.result === "string" && result.result) ||
						(result.errors ?? []).join("\n") ||
						`Claude Code finished with ${result.subtype}`,
				);
			}

			start();
			output.stopReason = result.stop_reason === "max_tokens" ? "length" : "stop";
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
			stream.end();
		} catch (error) {
			if (owned && !owned.detached && !owned.idle && runtime.live === owned) {
				runtime.live = undefined;
				stopLive(owned);
			}
			runtime.onActivity?.(model.provider, undefined);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}
