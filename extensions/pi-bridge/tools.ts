/**
 * The tools of pi's MCP server: questions to the user, permission requests,
 * wishes to change pi, pi's state and settings to read, and a few things to
 * change. Everything that changes pi for good asks the user first.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { piPackageDir } from "../shared/pi-install.ts";
import { MODE_CHANNEL, type ModeRequest } from "../shared/agent-bus.ts";
import { ask, formatAnswers, QUESTIONS_SCHEMA, type AskQuestion } from "./ask.ts";
import { agyRuleFor, describeAction, GATED_MODES, gateAction, type HookPayload, needsAsking } from "./agy-gate.ts";
import { addAllowRule, agyPermissionQuestion, choiceFrom, type PermissionDecision, permissionQuestion, ruleFor } from "./permission.ts";
import type { BridgeClient, BridgeTool, ToolResult } from "./server.ts";
import { addWish, cut, readWishes, SHORT_MAX, setWishStatus, WISH_STATUSES, type Wish, type WishStatus } from "./wishes.ts";
import { formatElapsed, MAX_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN, timeoutMsOf, type Watches } from "./watch.ts";
import { MAX_STEPS, STEP_STATUSES, type Stepper, summary } from "./steps.ts";
import { DEFAULT_PARALLEL, MAX_DEPTH, MAX_LEAVES, MAX_PARALLEL, PART_STATUSES } from "./workflow.ts";
import type { WorkflowRunner } from "./workflow-runner.ts";

export interface Host {
	pi: ExtensionAPI;
	/** The current session's context; unset before the session starts. */
	ctx(): ExtensionContext | undefined;
	/** Rules the user allowed for this pi session ("Allow for this session"). */
	sessionRules: Set<string>;
	/** Where wishes go (default ~/.pi/agent/wishes.md). */
	wishesFile?: string;
	/** Called after the wish list changed, to show it anew. */
	wishesChanged?(): void;
	/** Commands pi runs while an agent waits on something outside (watch.ts). */
	watches?: Watches;
	/** The stepper an agent shows above the editor (steps.ts). */
	steps?: Stepper;
	/** Workflows: big tasks as a tree of parts done by subagents (workflow.ts). */
	workflows?: WorkflowRunner;
}

export const wishesFileOf = (host: Host) => host.wishesFile ?? join(getAgentDir(), "wishes.md");

export interface ClientData {
	cwd: string;
	claudeSettings?: { project: string; user: string };
	agySettings?: string;
	mode?: string;
}

let dialogs: Promise<unknown> = Promise.resolve();

/** One dialog at a time: requests that come in together wait their turn. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
	const run = dialogs.then(fn, fn);
	dialogs = run.catch(() => undefined);
	return run;
}

/**
 * agy's PreToolUse hook (see agy-gate.ts): no opinion on what the gate leaves
 * to agy, allow what rules or the mode allow, else ask the user.
 */
export async function agyHook(host: Host, payload: HookPayload, client: BridgeClient): Promise<Record<string, string>> {
	const data = (client.data ?? {}) as ClientData;
	// In plan, auto and bypass the hook only holds agy while a dialog is open (see server.ts); agy's mode decides.
	if (!GATED_MODES.includes(data.mode ?? "default")) return {};
	const action = gateAction(payload);
	if (!action) return {};
	const userRules: string[] = (data.agySettings && readJsonFile(data.agySettings)?.permissions?.allow) || [];
	const sessionRules = [...host.sessionRules].filter((r) => r.startsWith("agy:")).map((r) => r.slice(4));
	const workspaces = payload.workspacePaths?.length ? payload.workspacePaths : [data.cwd];
	if (!needsAsking(action, data.mode ?? "default", workspaces, [...userRules, ...sessionRules])) return { decision: "allow" };
	const ctx = host.ctx();
	if (!ctx?.hasUI) return { decision: "deny", reason: NO_UI };
	const rule = agyRuleFor(action);
	const { title, preview } = describeAction(action, payload.toolCall?.args ?? {});
	const answer = await oneAtATime(() => ask(ctx.ui as any, [agyPermissionQuestion(title, preview, rule)]));
	const choice = choiceFrom(answer?.[0]);
	if (!choice.allow) return { decision: "deny", reason: choice.message };
	if (choice.scope !== "once") host.sessionRules.add(`agy:${rule}`);
	if (choice.scope === "always" && data.agySettings && !addAllowRule(data.agySettings, rule)) {
		ctx.ui.notify(`Could not save ${rule} to ${data.agySettings}`, "warning");
	}
	return { decision: "allow" };
}

/** The repository of this package, for wishes to change pi. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const NO_UI = "pi runs without a user interface (print or JSON mode), so nobody can answer.";

const text = (value: string, isError = false): ToolResult => ({ text: value, isError });
const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2) });

function uiCtx(host: Host): ExtensionContext {
	const ctx = host.ctx();
	if (!ctx?.hasUI) throw new Error(NO_UI);
	return ctx;
}

/** Asks before a lasting change; throws when the user says no. */
async function confirmChange(host: Host, title: string, message: string): Promise<void> {
	const ctx = uiCtx(host);
	if (!(await ctx.ui.confirm(title, message))) throw new Error("The user did not allow this change.");
}

const agentName = (client: BridgeClient) => ({ claude: "Claude", agy: "agy", pi: "The agent" })[client.kind];

function readJsonFile(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJsonFile(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** pi's documentation folder of the installed version. */
export function piDocsDir(): string | undefined {
	const root = piPackageDir();
	const docs = root && join(root, "docs");
	return docs && existsSync(docs) ? docs : undefined;
}

function githubRepo(): string | undefined {
	const url = readJsonFile(join(PACKAGE_ROOT, "package.json"))?.repository?.url;
	return typeof url === "string" ? url.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1] : undefined;
}

// =============================================================================
// Change requests
// =============================================================================

export const WISH_HERE = "Work on it here in this chat";
export const WISH_LIST = "Add to the wish list";
export const WISH_SESSION = "Work on it in a new pi session (command to the clipboard)";
export const WISH_ISSUE = "Open a GitHub issue";
export const WISH_APPLY = "Apply now";
export const WISH_NOTHING = "Nothing";

async function changeRequest(host: Host, args: Record<string, any>, client: BridgeClient): Promise<ToolResult> {
	const ctx = uiCtx(host);
	const request = String(args.request ?? "").trim();
	if (!request) throw new Error("request is empty");
	const title = String(args.title ?? "").trim() || request;
	const short = String(args.short ?? "").trim() || cut(title, SHORT_MAX);
	if (short.length > SHORT_MAX) {
		throw new Error(`short "${short}" has ${short.length} characters; call again with a short title of at most ${SHORT_MAX} (two or three words).`);
	}
	const setting = args.setting && typeof args.setting.key === "string" ? (args.setting as { key: string; value: unknown }) : undefined;
	const repo = githubRepo();
	// Only a checkout of the package can be worked on, committed and pushed.
	const here = existsSync(join(PACKAGE_ROOT, ".git"));
	const question: AskQuestion = {
		header: "Change pi",
		question: `${agentName(client)} noticed a wish to change pi:`,
		preview: `${title}\n\n${request}`,
		options: [
			...(setting
				? [{ label: WISH_APPLY, description: `Set ${setting.key} to ${JSON.stringify(setting.value)}`, recommended: true }]
				: []),
			...(here ? [{ label: WISH_HERE, description: `${agentName(client)} changes ${PACKAGE_ROOT}`, recommended: !setting }] : []),
			{ label: WISH_LIST, description: wishesFileOf(host), recommended: !setting && !here },
			{ label: WISH_SESSION, description: `pi in ${PACKAGE_ROOT}` },
			...(repo ? [{ label: WISH_ISSUE, description: repo }] : []),
			{ label: WISH_NOTHING },
		],
	};
	const answer = (await ask(ctx.ui as any, [question]))?.[0];
	const picked = answer?.selected[0];
	const note = answer?.own ? `\nThe user added: ${answer.own}` : "";
	const wish = answer?.own ? `${request}\n\n${answer.own}` : request;
	switch (picked) {
		case WISH_APPLY:
			return text(`${applySetting(host, setting!.key, setting!.value)}${note}`);
		case WISH_HERE:
			return text(
				`The user wants it done now, in this chat. Work on it in pi's extension package at ${PACKAGE_ROOT}; editing files there is allowed for this wish, even though it lies outside the current project. Leave the current project alone. Read ${join(PACKAGE_ROOT, "CLAUDE.md")} first and follow it: which extension the change belongs to, README, \`npm run check\` and \`npm test\`, commit and push. When done, tell the user to run /reload in pi to load the change.${note}`,
			);
		case WISH_LIST: {
			const file = wishesFileOf(host);
			const added = addWish(file, { title, short, description: wish, project: ctx.cwd });
			host.wishesChanged?.();
			return text(`The wish is on the wish list as #${added.id} (${file}). Tell the user; do not try to change pi from this project.${note}`);
		}
		case WISH_SESSION: {
			const command = `cd ${shellQuote(PACKAGE_ROOT)} && pi ${shellQuote(`${title}\n\n${wish}`)}`;
			const copied = await copyToClipboard(command);
			return text(
				`${copied ? "The command is on the clipboard" : "Copying failed; the command is"}: ${command}\nTell the user to run it in a new terminal; do not change pi from this project.${note}`,
			);
		}
		case WISH_ISSUE: {
			const result = await host.pi.exec("gh", ["issue", "create", "-R", repo!, "--title", title.split("\n")[0].slice(0, 80), "--body", wish]);
			if (result.code !== 0) return text(`Opening the issue failed: ${result.stderr || result.stdout}`, true);
			return text(`Issue opened: ${result.stdout.trim()}${note}`);
		}
		default:
			return text(`The user chose to do nothing about it.${note}`);
	}
}

function describeWish(w: Wish): string {
	const meta = [`status: ${w.status}`, w.added && `added ${w.added}`, w.done && `done ${w.done}`, w.project && `from ${w.project}`].filter(Boolean).join(", ");
	return `#${w.id} ${w.title} (short: ${w.short}; ${meta})\n${w.description}`;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function copyToClipboard(value: string): Promise<boolean> {
	const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
	return new Promise((resolve) => {
		const child = spawn(command, command === "xclip" ? ["-selection", "clipboard"] : []);
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
		child.stdin.end(value);
	});
}

// =============================================================================
// Settings
// =============================================================================

/** Sets one of pi's settings through its own setter, so pi keeps the file consistent. */
export function applySetting(host: Host, key: string, value: unknown): string {
	const ctx = host.ctx();
	if (key === "theme" && typeof value === "string" && ctx?.hasUI) {
		const result = ctx.ui.setTheme(value);
		if (!result.success) throw new Error(result.error ?? `Theme ${value} not found`);
	}
	const manager = SettingsManager.create(ctx?.cwd ?? process.cwd(), getAgentDir());
	const setter = `set${key[0].toUpperCase()}${key.slice(1)}`;
	const fn = (manager as any)[setter];
	if (typeof fn !== "function") {
		const known = Object.getOwnPropertyNames(Object.getPrototypeOf(manager))
			.filter((name) => /^set[A-Z]/.test(name))
			.map((name) => name[3].toLowerCase() + name.slice(4));
		throw new Error(`Unknown setting ${key}. Settings that can be set: ${known.join(", ")}`);
	}
	fn.call(manager, value);
	void manager.flush();
	return key === "theme" ? `Theme set to ${value}.` : `${key} set to ${JSON.stringify(value)}. Some settings take effect after /reload.`;
}

// =============================================================================
// Docs
// =============================================================================

function searchDocs(query: string | undefined, file: string | undefined): ToolResult {
	const dir = piDocsDir();
	if (!dir) return text("pi's documentation was not found.", true);
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	if (file) {
		const name = file.endsWith(".md") ? file : `${file}.md`;
		if (!files.includes(name)) return text(`No such doc. Docs: ${files.join(", ")}`, true);
		return text(readFileSync(join(dir, name), "utf8"));
	}
	if (!query) return text(`pi's docs (${dir}), read one with file: ${files.join(", ")}`);
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits: string[] = [];
	for (const name of files) {
		const lines = readFileSync(join(dir, name), "utf8").split("\n");
		lines.forEach((line, i) => {
			const lower = line.toLowerCase();
			if (words.every((w) => lower.includes(w))) hits.push(`${name}:${i + 1}: ${line.trim().slice(0, 200)}`);
		});
	}
	if (hits.length === 0) return text(`Nothing found for "${query}". Docs: ${files.join(", ")}`);
	return text(`${hits.slice(0, 60).join("\n")}${hits.length > 60 ? `\n… ${hits.length - 60} more` : ""}\nRead a whole doc with file: <name>.`);
}

// =============================================================================
// The tools
// =============================================================================

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function bridgeTools(host: Host): BridgeTool[] {
	const pi = host.pi;
	return [
		{
			name: "ask",
			description:
				"Ask the user one or more questions in a dialog in pi and wait for the answers. Use it instead of asking in your reply whenever you need a decision or information to go on. Each question can have options (one marked recommended, each with a description), single or multiple choice; the user can always type an own answer. Set `details` (or `input` on an option) when you want extra text with the choice.",
			inputSchema: obj({ title: { type: "string", description: "Optional title above the questions." }, questions: QUESTIONS_SCHEMA }, ["questions"]),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async call(args) {
				const ctx = uiCtx(host);
				const answers = await oneAtATime(() => ask(ctx.ui as any, args.questions as AskQuestion[], args.title));
				return text(formatAnswers(answers));
			},
		},
		{
			name: "permission",
			description: "Permission prompt for Claude Code (--permission-prompt-tool); not for direct use.",
			inputSchema: obj({ tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, ["tool_name", "input"]),
			only: ["claude"],
			async call(args, client) {
				const input = (args.input ?? {}) as Record<string, any>;
				const data = (client.data ?? {}) as ClientData;
				const request = { tool: String(args.tool_name), input };
				const rule = ruleFor(request, data.cwd ?? process.cwd());
				const decide = (decision: PermissionDecision) => text(JSON.stringify(decision));
				if (host.sessionRules.has(rule)) return decide({ behavior: "allow", updatedInput: input });
				const ctx = host.ctx();
				if (!ctx?.hasUI) return decide({ behavior: "deny", message: NO_UI });
				const question = permissionQuestion(request, agentName(client), rule, !!data.claudeSettings);
				const choice = choiceFrom((await oneAtATime(() => ask(ctx.ui as any, [question])))?.[0]);
				if (!choice.allow) return decide({ behavior: "deny", message: choice.message });
				if (choice.scope === "session") host.sessionRules.add(rule);
				if (choice.scope === "project" || choice.scope === "user") {
					const file = data.claudeSettings![choice.scope];
					if (!addAllowRule(file, rule)) ctx.ui.notify(`Could not save ${rule} to ${file}`, "warning");
					host.sessionRules.add(rule);
				}
				return decide({ behavior: "allow", updatedInput: input });
			},
		},
		{
			name: "change_request",
			description:
				"Call this when the user wants pi itself changed — pi is the terminal chat app you run in (its look, colours, theme, keys, commands, behaviour, extensions), e.g. 'make the CLI red' or 'the status line should show X'. Do not edit pi's files or the current project for such wishes before calling it. The user decides in a dialog what happens (apply a setting now, work on it here in pi's extension repository, wish list, new pi session there, GitHub issue); follow what the result says. Give every wish a `title`, a `short` title and the exact description in `request`, in the user's language. If the wish is just a pi setting, pass it in `setting` (see the `settings` tool for keys).",
			inputSchema: obj(
				{
					title: { type: "string", description: "Title of the wish, one line (e.g. 'Readable MCP tool calls in the chat')." },
					short: { type: "string", description: `Very short title, two or three words, at most ${SHORT_MAX} characters, listed in the empty chat (e.g. 'Readable MCP calls').`, maxLength: SHORT_MAX },
					request: { type: "string", description: "The exact description of the wish in the user's words, with enough context to act on it later." },
					setting: obj({ key: { type: "string" }, value: {} }, ["key", "value"]),
				},
				["title", "short", "request"],
			),
			annotations: WRITE,
			call: (args, client) => changeRequest(host, args, client),
		},
		{
			name: "wishes",
			description:
				"pi's wish list: wishes to change pi kept for later, each with number, title, short title, status (open, in progress, done) and description. Read it before working on a wish; `status` filters, `id` gives one wish.",
			inputSchema: obj({ status: { type: "string", enum: [...WISH_STATUSES] }, id: { type: "number" } }),
			annotations: READ,
			async call(args) {
				const file = wishesFileOf(host);
				const wishes = readWishes(file).filter((w) => (args.id === undefined || w.id === Number(args.id)) && (!args.status || w.status === args.status));
				if (wishes.length === 0) return text(args.id === undefined ? `No wishes${args.status ? ` ${args.status}` : ""} (${file}).` : `No wish #${args.id} (${file}).`);
				return text(`${file}\n\n${wishes.map(describeWish).join("\n\n")}`);
			},
		},
		{
			name: "wish_update",
			description:
				"Set the status of a wish on pi's wish list (see `wishes`): `in progress` when you start working on it, `done` when it is finished (committed and pushed), `open` to put it back. The empty chat lists the open wishes and marks those in progress.",
			inputSchema: obj({ id: { type: "number" }, status: { type: "string", enum: [...WISH_STATUSES] } }, ["id", "status"]),
			annotations: WRITE,
			async call(args) {
				const status = WISH_STATUSES.find((s) => s === args.status);
				if (!status) return text(`Unknown status ${args.status}; one of: ${WISH_STATUSES.join(", ")}`, true);
				const wish = setWishStatus(wishesFileOf(host), Number(args.id), status as WishStatus);
				if (!wish) return text(`No wish #${args.id} on the wish list.`, true);
				host.wishesChanged?.();
				return text(`Wish #${wish.id} "${wish.title}" is now ${wish.status}.`);
			},
		},
		{
			name: "status",
			description: "pi's current state: version, model, thinking level, session, working directory, context usage, theme.",
			inputSchema: obj({}),
			annotations: READ,
			async call() {
				const ctx = host.ctx();
				const pkg = readJsonFile(join(piPackageDir() ?? "", "package.json"));
				return json({
					version: pkg?.version,
					mode: ctx?.mode,
					hasUI: ctx?.hasUI,
					cwd: ctx?.cwd,
					model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
					thinkingLevel: pi.getThinkingLevel(),
					session: { name: pi.getSessionName(), id: ctx?.sessionManager.getSessionId?.(), file: ctx?.sessionManager.getSessionFile?.() },
					context: ctx?.getContextUsage(),
					theme: pi.getSettings().theme,
					projectTrusted: ctx?.isProjectTrusted(),
				});
			},
		},
		{
			name: "settings",
			description: "pi's effective settings (global ~/.pi/agent/settings.json merged with the project's .pi/settings.json).",
			inputSchema: obj({}),
			annotations: READ,
			call: async () => json(pi.getSettings()),
		},
		{
			name: "themes",
			description: "pi's themes and the current one.",
			inputSchema: obj({}),
			annotations: READ,
			async call() {
				const ctx = host.ctx();
				return json({ current: pi.getSettings().theme, themes: ctx?.hasUI ? ctx.ui.getAllThemes() : [] });
			},
		},
		{
			name: "keybindings",
			description: "pi's own keybindings from ~/.pi/agent/keybindings.json (defaults are in the docs, file keybindings).",
			inputSchema: obj({}),
			annotations: READ,
			call: async () => json(readJsonFile(join(getAgentDir(), "keybindings.json")) ?? {}),
		},
		{
			name: "commands",
			description: "pi's slash commands with where they come from (built in, extension, prompt template, skill).",
			inputSchema: obj({}),
			annotations: READ,
			call: async () =>
				json(pi.getCommands().map((c) => ({ name: c.name, description: c.description, source: c.source, path: (c.sourceInfo as any)?.path }))),
		},
		{
			name: "tools",
			description: "The tools pi has registered (its own models use them), with exposure and whether they are active.",
			inputSchema: obj({}),
			annotations: READ,
			async call() {
				const active = new Set(pi.getActiveTools());
				return json(pi.getAllTools().map((t: any) => ({ name: t.name, description: t.description?.slice(0, 160), exposure: t.exposure, active: active.has(t.name) })));
			},
		},
		{
			name: "mcp_servers",
			description: "pi's MCP servers: ~/.pi/agent/mcp.json, the project's .pi/mcp.json and those extensions registered.",
			inputSchema: obj({}),
			annotations: READ,
			async call() {
				const ctx = host.ctx();
				const redact = (servers: Record<string, any> | undefined) =>
					Object.fromEntries(
						Object.entries(servers ?? {}).map(([name, s]) => [name, { ...s, ...(s.headers ? { headers: "(hidden)" } : {}), ...(s.env ? { env: Object.keys(s.env) } : {}) }]),
					);
				return json({
					global: redact(readJsonFile(join(getAgentDir(), "mcp.json"))?.mcpServers),
					project: redact(ctx ? readJsonFile(join(ctx.cwd, ".pi", "mcp.json"))?.mcpServers : undefined),
					extensions: pi.getMcpServers().map((s) => ({ name: s.name, extension: s.extensionPath })),
				});
			},
		},
		{
			name: "docs",
			description: "pi's documentation of the installed version: list the docs, search them (`query`, all words must match a line) or read one (`file`, e.g. extensions, settings, themes, keybindings).",
			inputSchema: obj({ query: { type: "string" }, file: { type: "string" } }),
			annotations: READ,
			call: async (args) => searchDocs(args.query, args.file),
		},
		{
			name: "set_theme",
			description: "Switch pi's theme (asks the user first). See `themes` for the names.",
			inputSchema: obj({ name: { type: "string" } }, ["name"]),
			annotations: WRITE,
			async call(args) {
				await confirmChange(host, "Change pi's theme?", `Theme: ${args.name}`);
				return text(applySetting(host, "theme", String(args.name)));
			},
		},
		{
			name: "set_setting",
			description: "Change one of pi's settings in ~/.pi/agent/settings.json (asks the user first). `key` is the settings key, e.g. quietStartup, steeringMode, hideThinkingBlock.",
			inputSchema: obj({ key: { type: "string" }, value: {} }, ["key", "value"]),
			annotations: WRITE,
			async call(args) {
				await confirmChange(host, "Change a pi setting?", `${args.key} = ${JSON.stringify(args.value)}`);
				return text(applySetting(host, String(args.key), args.value));
			},
		},
		{
			name: "set_keybinding",
			description: "Bind keys to one of pi's actions in ~/.pi/agent/keybindings.json (asks the user first). `keys` like \"alt+t\"; null removes the binding. Takes effect after /reload. Action names are in the docs (file keybindings).",
			inputSchema: obj({ action: { type: "string" }, keys: { type: ["string", "array", "null"], items: { type: "string" } } }, ["action", "keys"]),
			annotations: WRITE,
			async call(args) {
				await confirmChange(host, "Change a pi keybinding?", `${args.action}: ${JSON.stringify(args.keys)}`);
				const file = join(getAgentDir(), "keybindings.json");
				const bindings = readJsonFile(file) ?? {};
				if (args.keys === null) delete bindings[args.action];
				else bindings[args.action] = args.keys;
				writeJsonFile(file, bindings);
				return text(`${args.action} bound to ${JSON.stringify(args.keys)}. The user needs /reload for it to take effect.`);
			},
		},
		{
			name: "set_model",
			description: "Switch pi's model for the next prompts (asks the user first). `provider` and `id` as listed by pi's /model.",
			inputSchema: obj({ provider: { type: "string" }, id: { type: "string" } }, ["provider", "id"]),
			annotations: WRITE,
			async call(args) {
				const ctx = uiCtx(host);
				const model = ctx.modelRegistry.find(String(args.provider), String(args.id));
				if (!model) {
					const ids = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
					return text(`No model ${args.provider}/${args.id}. Available: ${ids.join(", ")}`, true);
				}
				await confirmChange(host, "Switch pi's model?", `${model.provider}/${model.id}`);
				if (!(await pi.setModel(model))) return text("pi could not switch to that model (no credentials?).", true);
				return text(`Model switched to ${model.provider}/${model.id}; it applies from the next prompt.`);
			},
		},
		{
			name: "set_thinking_level",
			description: "Set pi's thinking level (asks the user first): off, minimal, low, medium, high, xhigh, max.",
			inputSchema: obj({ level: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, ["level"]),
			annotations: WRITE,
			async call(args) {
				await confirmChange(host, "Change the thinking level?", String(args.level));
				pi.setThinkingLevel(args.level);
				return text(`Thinking level set to ${args.level}; it applies from the next prompt.`);
			},
		},
		{
			name: "set_mode",
			description: "Switch the permission mode of the CLI agent in pi (what Shift+Tab does; asks the user first). Claude: auto, acceptEdits, plan. agy: default, accept-edits, plan, auto. Applies from the next prompt.",
			inputSchema: obj({ mode: { type: "string" } }, ["mode"]),
			annotations: WRITE,
			async call(args, client) {
				await confirmChange(host, `Switch ${agentName(client)}'s mode?`, String(args.mode));
				pi.events.emit(MODE_CHANNEL, { provider: client.provider, mode: String(args.mode) } satisfies ModeRequest);
				return text(`Mode switched to ${args.mode}; it applies from the next prompt.`);
			},
		},
		{
			name: "mcp_server_set",
			description: "Add, replace or remove an MCP server in pi's ~/.pi/agent/mcp.json (asks the user first). `config` like an mcpServers entry ({command, args, env} or {url, headers}); null removes it. CLI agents get it from the next prompt.",
			inputSchema: obj({ name: { type: "string" }, config: { type: ["object", "null"] } }, ["name", "config"]),
			annotations: { ...WRITE, destructiveHint: true },
			async call(args) {
				const shown = args.config === null ? "remove" : JSON.stringify(args.config, null, 2);
				await confirmChange(host, `Change MCP server ${args.name} in pi's mcp.json?`, shown);
				const file = join(getAgentDir(), "mcp.json");
				const config = readJsonFile(file) ?? {};
				config.mcpServers = config.mcpServers ?? {};
				if (args.config === null) delete config.mcpServers[args.name];
				else config.mcpServers[args.name] = args.config;
				writeJsonFile(file, config);
				return text(`mcp.json updated (${file}).`);
			},
		},
		{
			name: "rename_session",
			description: "Give the current pi session a name (shown in the session list).",
			inputSchema: obj({ name: { type: "string" } }, ["name"]),
			annotations: WRITE,
			async call(args) {
				pi.setSessionName(String(args.name));
				return text(`Session named ${args.name}.`);
			},
		},
		{
			name: "watch",
			description: `Wait for something outside that takes a while, e.g. a GitHub Actions run, a deployment or a PR's checks: pi runs the given shell command itself, independent of your turn and your process, shows it to the user and, when it ends or reaches its time limit, sends you a message with its exit code and the end of its output that starts a new turn. Use it instead of a background shell command, a sleep loop or polling yourself. The command should block until the thing is done and fail when it failed, e.g. \`gh run watch <run-id> --exit-status\`, \`gh pr checks <n> --watch --fail-fast\`, or \`until <check>; do sleep 30; done\`. After calling it, end your turn and tell the user what you are waiting for; do not wait in the same turn.`,
			inputSchema: obj(
				{
					command: { type: "string", description: "Shell command (run with /bin/sh -c) that blocks until the awaited thing is done." },
					description: { type: "string", description: "What is awaited, in a few words in the user's language, e.g. 'CI of PR #42'." },
					timeout_minutes: {
						type: "number",
						description: `Time limit in minutes (default ${DEFAULT_TIMEOUT_MIN}, at most ${MAX_TIMEOUT_MIN}); the command is stopped and you are told when it is reached.`,
					},
					cwd: { type: "string", description: "Working directory; default your working directory." },
				},
				["command", "description"],
			),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
			async call(args, client) {
				const watches = host.watches;
				if (!watches) return text("Watches are not available.", true);
				const command = String(args.command ?? "").trim();
				if (!command) return text("`command` is empty.", true);
				const cwd = String(args.cwd || ((client.data ?? {}) as ClientData).cwd || host.ctx()?.cwd || process.cwd());
				if (!existsSync(cwd)) return text(`The working directory ${cwd} does not exist.`, true);
				const timeoutMs = timeoutMsOf(args.timeout_minutes);
				const watch = watches.start({ command, description: String(args.description ?? command).trim() || command, cwd, timeoutMs });
				return text(
					`Watch #${watch.id} started (time limit ${formatElapsed(timeoutMs)}). pi will send you a message with the result when it ends. End your turn now and tell the user what you are waiting for.`,
				);
			},
		},
		{
			name: "watches",
			description: "The watches pi is running for you (see `watch`), with how long each has been running.",
			inputSchema: obj({}),
			annotations: READ,
			async call() {
				const now = Date.now();
				return json(
					(host.watches?.list() ?? []).map((w) => ({
						id: w.id,
						description: w.description,
						command: w.command,
						cwd: w.cwd,
						running: formatElapsed(now - w.startedAt),
						timeLimit: formatElapsed(w.timeoutMs),
					})),
				);
			},
		},
		{
			name: "watch_stop",
			description: "Stop a watch (see `watch`) you no longer need; you still get its message, marked as stopped.",
			inputSchema: obj({ id: { type: "number" } }, ["id"]),
			annotations: WRITE,
			async call(args) {
				return host.watches?.stop(Number(args.id)) ? text(`Stopping watch #${args.id}.`) : text(`No running watch #${args.id}.`, true);
			},
		},
		{
			name: "steps_set",
			description: `Show the user a stepper above pi's editor for a job of several steps you are about to do, e.g. putting an app on a phone: 1. Build the APK, 2. Check the device, 3. Install the APK, 4. Start the app. Replaces the steps shown before. Then move each step on with \`steps_update\` as you work (running when you start it, done, failed or skipped when it ended), so the user sees live where you are ("Step 2 of 4"). A finished list goes away by itself after a few seconds; \`steps_clear\` removes it earlier. Use it for jobs of about 3 or more steps that take a while, not for single quick actions.`,
			inputSchema: obj(
				{
					title: { type: "string", description: "What the whole job is, in a few words in the user's language, e.g. 'Install the app'." },
					steps: {
						type: "array",
						minItems: 1,
						maxItems: MAX_STEPS,
						description: "The steps in order.",
						items: obj(
							{
								title: { type: "string", description: "The step in a few words in the user's language." },
								detail: { type: "string", description: "Optional short detail, e.g. the command it runs." },
								status: { type: "string", enum: [...STEP_STATUSES], description: "Default pending; e.g. running for the step you start right away." },
							},
							["title"],
						),
					},
				},
				["steps"],
			),
			annotations: WRITE,
			async call(args) {
				if (!host.steps) return text("Steps are not available.", true);
				try {
					return text(summary(host.steps.set(args.title, args.steps)));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "steps_update",
			description:
				"Set the status of one step of the stepper shown with `steps_set`: running when you start it, done when it worked, failed (with the reason as note) or skipped. Optionally a short note shown with it, e.g. the device found or the error.",
			inputSchema: obj(
				{
					step: { type: "number", description: "The step's number, 1 for the first." },
					status: { type: "string", enum: [...STEP_STATUSES] },
					note: { type: "string", description: "Short note shown with the step; empty to remove it." },
					detail: { type: "string", description: "Replaces the step's detail; empty to remove it." },
				},
				["step"],
			),
			annotations: WRITE,
			async call(args) {
				if (!host.steps) return text("Steps are not available.", true);
				try {
					host.steps.update(args.step, args.status, { note: args.note, detail: args.detail });
					return text(summary(host.steps.list!));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "steps_clear",
			description: "Remove the stepper shown with `steps_set` (a finished one also goes away by itself).",
			inputSchema: obj({}),
			annotations: WRITE,
			async call() {
				return text(host.steps?.clear() ? "Steps removed." : "No steps were shown.");
			},
		},
		{
			name: "workflow_plan",
			description: `Plan a big task as a workflow and have the user review it before it runs. Use it when the user asks for a workflow, or by yourself when a task is big enough to split into many parts that subagents can each do on their own (e.g. a feature with several components, a migration across many files). Split the task into big parts and each big part into small parts (nested as deep as needed, up to ${MAX_DEPTH} levels); a small part (one without parts) is done by one subagent, so it must be self-contained and clear. Ids are positions: 1 is the first big part, 1.2 its second part. Use \`dependsOn\` for parts that need others done first (ids of any level; a dependency of a big part holds for all its parts); everything else may run in parallel. pi shows the plan as a tree; the user can edit, add and remove parts, choose the subagents' model, and approve it or send it back with feedback. The call waits for that. Approved, it tells you how to run it with workflow_next and workflow_update.`,
			inputSchema: obj(
				{
					title: { type: "string", description: "The whole task in a few words in the user's language, e.g. 'Build the car model'." },
					goal: { type: "string", description: "The task in the user's words, with what done means." },
					model: { type: "string", description: "Default model for the subagents (e.g. haiku, sonnet, opus); unset is your own default." },
					parallel: { type: "number", description: `Most subagents at once, 1–${MAX_PARALLEL}; default ${DEFAULT_PARALLEL}.` },
					parts: {
						type: "array",
						minItems: 1,
						description: `The big parts in order, each with its parts; at most ${MAX_LEAVES} small parts in all.`,
						items: {
							type: "object",
							properties: {
								title: { type: "string", description: "The part in a few words in the user's language." },
								detail: { type: "string", description: "What exactly to do, for the subagent (small parts) or what the big part is about." },
								model: { type: "string", description: "Model for this part's subagents, if not the default." },
								dependsOn: { type: "array", items: { type: "string" }, description: "Ids of parts that must be done first, e.g. ['1', '2.3']." },
								parts: { type: "array", description: "Its parts, same shape; none for a small part.", items: { type: "object" } },
							},
							required: ["title"],
						},
					},
				},
				["title", "parts"],
			),
			annotations: WRITE,
			async call(args, client) {
				if (!host.workflows) return text("Workflows are not available.", true);
				try {
					return text(await host.workflows.plan(args, ((client.data ?? {}) as ClientData).cwd ?? process.cwd()));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "workflow_next",
			description:
				"Get the small parts of the approved workflow that can start now (pi marks them running) with what each subagent needs to know: its task, where it fits in, the results it builds on, the description and model for the subagent. Also tells you what the user changed meanwhile (edited, added, cancelled or restarted parts, paused), when to wait for running subagents, and when the workflow is finished. Call it after approval and after every workflow_update.",
			inputSchema: obj({ workflow: { type: "number", description: "The workflow's number; default the current one." } }),
			annotations: WRITE,
			async call(args) {
				if (!host.workflows) return text("Workflows are not available.", true);
				try {
					return text(host.workflows.next(args.workflow));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "workflow_update",
			description:
				"Report how a small part of the workflow ended once its subagent is done: status done or failed, its short summary as result and the tokens it used. pi hands a part that failed out once more; failing again, it asks the user. Status pending hands a part out again (e.g. its subagent was lost); running and skipped are also allowed.",
			inputSchema: obj(
				{
					workflow: { type: "number", description: "The workflow's number; default the current one." },
					id: { type: "string", description: "The part's id, e.g. '1.2'." },
					status: { type: "string", enum: [...PART_STATUSES] },
					result: { type: "string", description: "What the subagent did or found, in a few sentences; for failed, why." },
					tokens: { type: "number", description: "Total tokens the subagent used (from its usage), if known." },
					note: { type: "string", description: "Short note shown with the part; empty to remove it." },
				},
				["id", "status"],
			),
			annotations: WRITE,
			async call(args) {
				if (!host.workflows) return text("Workflows are not available.", true);
				try {
					return text(host.workflows.update(args));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "workflow_status",
			description: "Read a workflow as a tree: every part with its id, status, dependencies, model, tokens and result. With list: the workflows saved for this folder (to continue one, call workflow_next with its number).",
			inputSchema: obj({ workflow: { type: "number", description: "The workflow's number; default the current one." }, list: { type: "boolean" } }),
			annotations: READ,
			async call(args, client) {
				if (!host.workflows) return text("Workflows are not available.", true);
				try {
					return text(host.workflows.status(args, ((client.data ?? {}) as ClientData).cwd ?? process.cwd()));
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			},
		},
		{
			name: "notify",
			description: "Show a short notification in pi (e.g. when a long task is done).",
			inputSchema: obj({ message: { type: "string" }, type: { type: "string", enum: ["info", "warning", "error"] } }, ["message"]),
			annotations: WRITE,
			async call(args) {
				uiCtx(host).ui.notify(String(args.message), args.type ?? "info");
				return text("Shown.");
			},
		},
	];
}

/** Instructions the CLIs get with the server. */
export const SERVER_INSTRUCTIONS = `pi is the terminal chat app the user talks to you through. These tools reach pi itself.
- Ask the user with \`ask\` whenever you need a decision or information: it shows a dialog with options and a field for an own answer. Prefer it to asking in your reply.
- When the user wants pi itself changed (its look, theme, colours, keys, commands, behaviour, extensions), call \`change_request\` instead of editing files.
- \`wishes\` reads pi's wish list; when you start working on one of its wishes, set it \`in progress\` with \`wish_update\`, and \`done\` when it is finished.
- To wait for something outside that takes a while (a CI run, a deployment, a PR's checks), start a \`watch\` and end your turn: pi runs the command and starts a new turn with its result. Prefer it to background shell commands and sleep loops, which can be ended between turns.
- For a job of several steps that takes a while (e.g. build, install and start an app), show them as a stepper with \`steps_set\` and move each on with \`steps_update\` as you go, so the user sees where you are.
- For a big task that splits into many parts subagents can each do on their own, or when the user asks for a workflow, plan it with \`workflow_plan\`: the user reviews the tree of parts, then you run it with \`workflow_next\` and \`workflow_update\`, doing each small part in a subagent.
- \`status\`, \`settings\`, \`themes\`, \`keybindings\`, \`commands\`, \`tools\`, \`mcp_servers\` and \`docs\` read pi's state; the set_* tools change it after asking the user.`;
