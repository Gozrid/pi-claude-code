/**
 * Claude Code provider for pi
 *
 * Registers one pi provider per configured Claude CLI instance (default: a
 * single "claude-code" provider running `claude`). Every model request runs
 * the instance's CLI in print mode (stream-json in/out). Claude Code works
 * with its own tools, login, CLAUDE.md and settings; pi shows its text,
 * thinking and tool activity live. One pi session maps to one Claude Code
 * session per instance, continued with --resume on later prompts. A steer
 * (Enter while it works) goes into the running CLI at once and reaches Claude
 * after its current step, not only when its whole answer is done. While
 * Claude's background tasks run, its CLI stays after the answer, takes the
 * next prompt and starts a pi turn by itself when a task ends.
 *
 * The model list and plan usage come from each CLI itself (the `initialize`
 * and `get_usage` control requests). They are cached, loaded at startup and
 * refreshed in the background, so models a `claude` update adds show up in pi
 * on their own.
 *
 * Usage:
 *   pi --model claude-code/opus        (or /model inside pi)
 *   /claude-add                        (wizard: add a CLI instance, incl. browser sign-in)
 *   /login                             ("Claude CLI · …": add an account or sign an instance in again)
 *   /claude-setup                      (add, edit or remove CLI instances)
 *   /claude-setup add <name> = <base command>
 *   /claude-setup remove <name>
 *   /claude-mode [auto|acceptEdits|plan|dontAsk|bypassPermissions|manual]
 *   /claude-new                        (start a fresh Claude Code session)
 *   /claude-models                     (reload the model lists from the CLIs now)
 *   /claude-usage                      (plan usage limits; also in the agent-status-line extension)
 *   /claude-scratch                    (show the session's scratch directory)
 *
 * Only the connection to the CLI lives here. What the CLI does is published on
 * the event channels of ../shared/agent-bus.ts; agent-status-line, work-status,
 * task-list, permission-retry and chat-crab show it, and agent-status-line's
 * Shift+Tab switches the mode through MODE_CHANNEL.
 *
 * Configuration: ~/.pi/agent/claude-code.json
 *   { "instances": [ { "name": "Personal", "command": "claude" },
 *                    { "name": "Work",     "command": "CLAUDE_CONFIG_DIR=~/.claude-work claude" } ] }
 *
 * Environment:
 *   PI_CLAUDE_BIN              command of the default instance (default: "claude")
 *   PI_CLAUDE_PERMISSION_MODE  initial permission mode (default: "auto")
 *   PI_CLAUDE_EXTRA_ARGS       extra CLI args, whitespace separated
 *   PI_CLAUDE_THINKING_DISPLAY thinking text: "summarized" (default) or "omitted"
 *   PI_CLAUDE_SCRATCH_DIR      base directory for per-session scratch dirs (default: system temp)
 *   PI_CLAUDE_NO_BROWSER       set to sign in without opening a browser (link is shown instead)
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	ACTIVITY_CHANNEL,
	type ActivityEvent,
	BRIDGE_CHANNEL,
	type BridgeRequest,
	type BridgeServerInfo,
	DENIALS_CHANNEL,
	type DenialsEvent,
	MODE_CHANNEL,
	type ModeRequest,
	ONESHOT_CHANNEL,
	SUBAGENTS_CHANNEL,
	type SubagentsEvent,
	type OneShotRequest,
	TOOL_CHANNEL,
	type UsageAccount,
	USAGE_CHANNEL,
	USAGE_REFRESH_CHANNEL,
	type UsageEvent,
	type UsageRefreshRequest,
} from "../shared/agent-bus.ts";
import { formatDuration } from "../shared/format.ts";
import {
	type CliInfo,
	FALLBACK_MODELS,
	loadCachedModels,
	queryCli,
	sameModels,
	saveCachedModels,
	toProviderModel,
	withPinnedModels,
} from "./cli.ts";
import {
	API_PREFIX,
	CONFIG_FILE,
	configDirOf,
	type Instance,
	loadConfiguredInstances,
	loadInstances,
	providerIdFor,
	saveInstances,
} from "./config.ts";
import { EDIT_TOOLS } from "./diff.ts";
import { loginInstance } from "./login.ts";
import { oneShot } from "./oneshot.ts";
import { type InstanceState, isClaudeProvider, MODE_CYCLE, PERMISSION_MODES, runtime } from "./state.ts";
import { createPublisher, SOURCE } from "./status.ts";
import {
	dropLiveRun,
	forgetSessions,
	loadSessions,
	scratchDir,
	sessionKey,
	steerRun,
	stopLiveRun,
	streamClaudeCode,
} from "./stream.ts";
import { SubagentWatcher, subagentsDir } from "./subagents.ts";
import { bar, usageWindows } from "./usage.ts";
import { ctxUi, oauthUi, type Probe, runAddWizard, type WizardUi } from "./wizard.ts";

/** Chat messages about Claude's background tasks: one ended and Claude goes on, or they were stopped. */
const BACKGROUND_MESSAGE = "claude-code-background";

/** Provider that only exists to put "add another account" into /login. */
const SETUP_PROVIDER_ID = "claude-cli-setup";

/**
 * What pi stores after a /login: the CLI keeps the real tokens in its own config
 * dir, pi only needs a credential that never expires.
 */
function cliCredentials() {
	return { access: "claude-cli", refresh: "claude-cli", expires: Date.now() + 10 * 365 * 24 * 3600_000 };
}

function newInstanceState(instance: Instance): InstanceState {
	return {
		instance,
		models: loadCachedModels(instance.id) ?? FALLBACK_MODELS,
		thinkingDisplay: process.env.PI_CLAUDE_THINKING_DISPLAY || "summarized",
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	const publisher = createPublisher(pi.events, () => pi.getThinkingLevel());
	/** Publishes the status and the task list again; for the last context seen when none is given. */
	const status = {
		render: (ctx?: ExtensionContext) => {
			publisher.status(ctx);
			publisher.tasks(ctx);
		},
	};
	/** Plan usage of every instance, for usage-graph. */
	const publishUsage = () => {
		const accounts = [...runtime.instances.values()].flatMap((state): UsageAccount[] => {
			const windows = usageWindows(state.usage);
			return windows.length > 0 ? [{ id: state.instance.id, name: `Claude · ${state.instance.name}`, windows }] : [];
		});
		pi.events.emit(USAGE_CHANNEL, { source: SOURCE, accounts } satisfies UsageEvent);
	};
	runtime.onUsage = () => {
		publisher.status();
		publishUsage();
	};
	runtime.onTasks = () => publisher.tasks();
	runtime.onTool = (event) => pi.events.emit(TOOL_CHANNEL, event);
	runtime.onActivity = (provider, activity) => pi.events.emit(ACTIVITY_CHANNEL, { provider, activity } satisfies ActivityEvent);
	runtime.piTools = () => pi.getAllTools();
	// A background task of Claude ended and Claude goes on by itself: a turn shows what it does.
	runtime.onWake = (_provider, text) =>
		pi.sendMessage({ customType: BACKGROUND_MESSAGE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	// Claude Code had to end while background tasks ran: the chat says so, and Claude learns it with the next prompt.
	runtime.onTasksStopped = (descriptions) => {
		const list = descriptions.map((d) => `"${d}"`).join(", ");
		const content = `Claude Code was ended; ${descriptions.length === 1 ? "its background task was" : "its background tasks were"} stopped: ${list}.`;
		pi.sendMessage({ customType: BACKGROUND_MESSAGE, content, display: true, details: { stopped: descriptions } }, { triggerTurn: false });
	};
	pi.registerMessageRenderer(BACKGROUND_MESSAGE, (message, _options, theme) => {
		const stopped = (message.details as { stopped?: string[] } | undefined)?.stopped;
		const text = String(message.content);
		return new Text(stopped ? theme.fg("warning", `⚠ ${text}`) : theme.fg("dim", `⏺ ${text}`), 0, 0);
	});
	runtime.bridge = (provider, command) => {
		let server: BridgeServerInfo | undefined;
		pi.events.emit(BRIDGE_CHANNEL, {
			provider,
			kind: "claude",
			cwd: runtime.cwd,
			claudeSettings: {
				project: join(runtime.cwd, ".claude", "settings.local.json"),
				user: join(configDirOf(command), "settings.json"),
			},
			reply: (info) => {
				server = info;
			},
		} satisfies BridgeRequest);
		return server;
	};

	pi.events.on(ONESHOT_CHANNEL, (data) => {
		const request = data as OneShotRequest;
		if (!isClaudeProvider(request?.provider)) return;
		request.claim();
		void oneShot(request.provider, request.system, request.prompt).then(request.reply, () => request.reply(undefined));
	});

	const setMode = (mode: string) => {
		runtime.permissionMode = mode;
		publisher.status();
	};

	// Shift+Tab in agent-status-line: the next mode of the cycle, or the one asked for.
	pi.events.on(MODE_CHANNEL, (data) => {
		const request = data as ModeRequest;
		if (!isClaudeProvider(request?.provider)) return;
		const next = request.mode ?? MODE_CYCLE[(MODE_CYCLE.indexOf(runtime.permissionMode) + 1) % MODE_CYCLE.length];
		if (PERMISSION_MODES.includes(next)) setMode(next);
	});

	/** Actions Claude was not allowed to take: permission-retry offers to allow them and retry. */
	const publishDenials = (ctx: ExtensionContext) => {
		const denials = runtime.denials;
		runtime.denials = undefined;
		const provider = ctx.model?.provider;
		if (!denials || !provider || !isClaudeProvider(provider)) return;
		const tools = [...new Set(denials.items.map((item) => item.tool))];
		const event: DenialsEvent = {
			provider,
			mode: denials.mode,
			items: denials.items,
			choices: [
				{
					label: `Allow ${tools.join(", ")} once and retry`,
					apply: () => {
						runtime.allowOnce = tools;
					},
				},
				...(tools.some((tool) => EDIT_TOOLS.has(tool)) && runtime.permissionMode !== "acceptEdits"
					? [{ label: "Switch to accept edits and retry", apply: () => setMode("acceptEdits") }]
					: []),
			],
		};
		pi.events.emit(DENIALS_CHANNEL, event);
	};

	// ---------------------------------------------------------------------------
	// Instances and their providers
	// ---------------------------------------------------------------------------

	const register = (state: InstanceState) =>
		pi.registerProvider(state.instance.id, {
			// Shown in /model and /login; the shared prefix keeps all instances together in /login.
			name: `Claude CLI · ${state.instance.name}`,
			baseUrl: "cli://claude",
			// Claude Code authenticates itself; pi only needs a non-empty key to send requests.
			apiKey: "claude-cli",
			// One API id per instance, so unregistering one provider leaves the others' stream in place.
			api: `${API_PREFIX}:${state.instance.id}`,
			models: withPinnedModels(state.models).map((m) => toProviderModel(state.instance.name, m)),
			streamSimple: streamClaudeCode,
			// Lists the instance in /login, to sign its CLI in again (or into another account).
			oauth: {
				name: `Claude CLI · ${state.instance.name}`,
				isSubscription: true,
				login: async (callbacks) => {
					const ui = oauthUi(callbacks);
					const account = await loginInstance(state.instance, runtime.cwd, ui, { signal: callbacks.signal });
					ui.progress(`${state.instance.name}: signed in as ${account.email ?? "unknown account"}`);
					const current = runtime.instances.get(state.instance.id);
					if (current) await refresh(current, runtime.cwd).catch(() => false);
					return cliCredentials();
				},
				refreshToken: async (credentials) => ({ ...credentials, expires: cliCredentials().expires }),
				getApiKey: () => "claude-cli",
			},
		});

	/** Brings the registered providers in line with the given instance list. */
	const applyInstances = (instances: Instance[]) => {
		const ids = new Set(instances.map((i) => i.id));
		for (const id of [...runtime.instances.keys()]) {
			if (!ids.has(id)) {
				runtime.instances.delete(id);
				pi.unregisterProvider(id);
			}
		}
		for (const instance of instances) {
			const existing = runtime.instances.get(instance.id);
			if (existing && existing.instance.command !== instance.command) {
				// A different CLI may support other flags than the one probed before.
				existing.thinkingDisplay = process.env.PI_CLAUDE_THINKING_DISPLAY || "summarized";
			}
			const state = existing ?? newInstanceState(instance);
			state.instance = instance;
			runtime.instances.set(instance.id, state);
			register(state);
		}
	};

	const applyInfo = (state: InstanceState, info: CliInfo): boolean => {
		state.account = info.account;
		state.claudeVersion = info.version;
		if (info.usage) {
			state.usage = info.usage;
			status.render();
			publishUsage();
		}
		saveCachedModels(state.instance.id, info.models, info.version);
		if (sameModels(info.models, state.models)) return false;
		state.models = info.models;
		if (runtime.instances.get(state.instance.id) === state) register(state);
		return true;
	};

	/** Re-reads models and plan usage from one CLI; resolves true when its model list changed. */
	const refresh = (state: InstanceState, cwd: string): Promise<boolean> => {
		state.discovery ??= queryCli(state, cwd)
			.then((info) => applyInfo(state, info))
			.finally(() => {
				state.discovery = undefined;
			});
		return state.discovery;
	};

	const refreshAll = (cwd: string) =>
		Promise.allSettled([...runtime.instances.values()].map((state) => refresh(state, cwd)));

	// usage-graph asks for fresh usage of every account.
	pi.events.on(USAGE_REFRESH_CHANNEL, (data) => {
		const request = data as UsageRefreshRequest;
		request.pending(refreshAll(request.cwd || runtime.cwd));
	});

	applyInstances(loadInstances());

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	let ticker: ReturnType<typeof setInterval> | undefined;

	// The subagents of the selected instance's Claude session, for the subagents extension.
	const watcher = new SubagentWatcher();
	let watching: ReturnType<typeof setInterval> | undefined;
	const sessionDir = (): string | undefined => {
		const provider = publisher.context?.model?.provider;
		const state = provider ? runtime.instances.get(provider) : undefined;
		if (!provider || !state || !runtime.sessionId) return undefined;
		const key = sessionKey(provider, runtime.sessionId);
		const claudeSessionId = (runtime.live?.key === key ? runtime.live.claudeSessionId : undefined) ?? loadSessions()[key]?.claudeSessionId;
		return claudeSessionId ? subagentsDir(join(configDirOf(state.instance.command), "projects"), runtime.cwd, claudeSessionId) : undefined;
	};
	const pollSubagents = () => {
		let agents;
		try {
			agents = watcher.poll(sessionDir(), runtime.live !== undefined);
		} catch {
			return;
		}
		if (agents) pi.events.emit(SUBAGENTS_CHANNEL, { source: SOURCE, agents } satisfies SubagentsEvent);
	};

	pi.on("session_start", async (_event, ctx) => {
		runtime.sessionId = ctx.sessionManager.getSessionId();
		runtime.cwd = ctx.cwd;
		runtime.projectTrusted = ctx.isProjectTrusted();
		status.render(ctx);
		// Runs in the background so startup is not held up by the CLIs. pi may have finished
		// (print mode) or replaced the session by the time it returns, which makes ctx stale.
		const hasUI = ctx.hasUI;
		const states = [...runtime.instances.values()];
		void refreshAll(ctx.cwd).then((results) => {
			if (!hasUI) return;
			try {
				states.forEach((state, i) => {
					const r = results[i];
					if (r?.status !== "fulfilled" || !r.value) return;
					ctx.ui.notify(
						`${state.instance.name}: ${withPinnedModels(state.models).length} models loaded from the CLI`,
						"info",
					);
				});
			} catch {
				// Stale context: the updated models are registered anyway.
			}
		});
		if (ctx.hasUI && !ticker) {
			let ticks = 0;
			ticker = setInterval(() => {
				publisher.status();
				// Every 5 minutes, pick up usage from other Claude sessions while pi is idle.
				const current = publisher.context;
				const state = current?.model ? runtime.instances.get(current.model.provider) : undefined;
				if (++ticks % 10 === 0 && state && current?.isIdle()) refresh(state, current.cwd).catch(() => {});
			}, 30_000);
			ticker.unref?.();
		}
		if (ctx.hasUI && !watching) {
			watching = setInterval(pollSubagents, 1000);
			watching.unref?.();
		}
		pollSubagents();
	});

	pi.on("agent_start", async (_event, ctx) => {
		runtime.denials = undefined;
		status.render(ctx);
	});
	// Steering reaches the running CLI at once; pi queues it as well and delivers it when the CLI takes it up.
	pi.on("input", async (event) => {
		// Commands and templates are expanded later; only plain text is known to match what pi delivers.
		if (event.streamingBehavior === "steer" && !event.text.trimStart().startsWith("/")) steerRun(event.text, event.images);
		return { action: "continue" };
	});
	pi.on("agent_end", async (_event, ctx) => {
		// A steer pi did not deliver (taken back into the editor) leaves no CLI waiting for it.
		dropLiveRun();
		status.render(ctx);
		publishDenials(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		status.render(ctx);
		pollSubagents();
	});
	pi.on("thinking_level_select", async (_event, ctx) => publisher.status(ctx));
	pi.on("turn_end", async (_event, ctx) => publisher.status(ctx));
	pi.on("agent_settled", async (_event, ctx) => publisher.status(ctx));

	pi.on("session_shutdown", async () => {
		// The background tasks of the session's Claude end with pi's session.
		stopLiveRun({ report: false });
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (watching) clearInterval(watching);
		watching = undefined;
		publisher.reset();
	});

	// ---------------------------------------------------------------------------
	// /claude-setup: manage CLI instances
	// ---------------------------------------------------------------------------

	const instanceList = () => [...runtime.instances.values()].map((s) => s.instance);

	const describe = (state: InstanceState) => {
		const account = [state.account?.email, state.account?.subscriptionType].filter(Boolean).join(" · ");
		return `${state.instance.name} → ${state.instance.id}/… · ${state.instance.command}${account ? ` · ${account}` : ""}`;
	};

	/** Tests a base command by asking that CLI for its models; returns what it reported. */
	const probe = async (name: string, command: string): Promise<Probe> => {
		const state = newInstanceState({ id: "probe", name, command });
		try {
			const info = await queryCli(state, runtime.cwd);
			return { info, thinkingDisplay: state.thinkingDisplay };
		} catch (error) {
			return { error: errorText(error) };
		}
	};

	/**
	 * Adds a new instance, or updates `existingId` with a new name and command.
	 * The implicit default instance is not carried over: the first instance the
	 * user adds replaces it. `tested` skips the probe when the caller already ran it.
	 */
	const saveInstance = async (
		ui: WizardUi,
		name: string,
		command: string,
		existingId?: string,
		tested?: Probe,
	): Promise<Instance | undefined> => {
		if (!tested) {
			tested = await probe(name, command);
			if (tested.error) {
				const keep =
					ui.interactive &&
					(await ui.confirm(`"${command}" did not answer`, `${tested.error}\n\nSave this instance anyway?`));
				if (!keep) {
					ui.notify(`Not saved. "${command}" failed: ${tested.error}`, "error");
					return undefined;
				}
			}
		}

		const instances = loadConfiguredInstances();
		let target: Instance;
		if (existingId) {
			// Editing the implicit default turns it into a configured instance.
			const current = instances.find((i) => i.id === existingId) ?? runtime.instances.get(existingId)?.instance;
			if (!current) return undefined;
			target = { ...current, name, command };
			const index = instances.findIndex((i) => i.id === existingId);
			if (index >= 0) instances.splice(index, 1, target);
			else instances.push(target);
		} else {
			target = { id: providerIdFor(name, new Set(instances.map((i) => i.id))), name, command };
			instances.push(target);
		}
		if (!saveInstances(instances)) {
			ui.notify(`Could not write ${CONFIG_FILE}`, "error");
			return undefined;
		}
		applyInstances(instances);
		const state = runtime.instances.get(target.id)!;
		if (tested.info) {
			state.thinkingDisplay = tested.thinkingDisplay;
			applyInfo(state, tested.info);
		}
		const models = tested.info ? `${withPinnedModels(state.models).length} models` : "not reachable yet";
		ui.notify(
			`${existingId ? "Updated" : "Added"} ${describe(state)}\n${models}. Pick its models with /model (provider ${target.id}).`,
			"info",
		);
		status.render();
		return target;
	};

	const removeInstance = (ui: WizardUi, id: string) => {
		const instances = loadConfiguredInstances().filter((i) => i.id !== id);
		const removed = runtime.instances.get(id)?.instance;
		if (!saveInstances(instances)) {
			ui.notify(`Could not write ${CONFIG_FILE}`, "error");
			return;
		}
		// An empty list falls back to the default instance.
		applyInstances(loadInstances());
		ui.notify(`Removed ${removed?.name ?? id}.`, "info");
		status.render();
	};

	const findByName = (name: string) =>
		instanceList().find((i) => i.name.toLowerCase() === name.toLowerCase() || i.id === name);

	const addWizard = (ui: WizardUi, signal?: AbortSignal) =>
		runAddWizard(ui, {
			cwd: runtime.cwd,
			configured: loadConfiguredInstances(),
			probe,
			save: (wizardUi, name, command, tested) => saveInstance(wizardUi, name, command, undefined, tested),
			signal,
		});

	pi.registerCommand("claude-add", {
		description: "Wizard: add a Claude CLI instance (existing login, new browser sign-in or own command)",
		handler: async (_arg, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The wizard needs the interactive UI. Use: /claude-setup add <name> = <base command>", "error");
				return;
			}
			await addWizard(ctxUi(ctx));
		},
	});

	// "Add another account" in /login runs the same wizard through pi's login dialogs.
	pi.registerProvider(SETUP_PROVIDER_ID, {
		name: "Claude CLI · add another account…",
		baseUrl: "cli://claude",
		apiKey: "claude-cli",
		api: `${API_PREFIX}:setup`,
		models: [],
		streamSimple: streamClaudeCode,
		oauth: {
			name: "Claude CLI · add another account…",
			isSubscription: true,
			login: async (callbacks) => {
				const saved = await addWizard(oauthUi(callbacks), callbacks.signal);
				if (!saved) throw new Error("No Claude CLI instance was added");
				return cliCredentials();
			},
			refreshToken: async (credentials) => ({ ...credentials, expires: cliCredentials().expires }),
			getApiKey: () => "claude-cli",
		},
	});

	pi.registerCommand("claude-setup", {
		description: "Manage Claude CLI instances: list | add <name> = <command> | remove <name> (no args: interactive)",
		handler: async (arg, ctx) => {
			const input = arg?.trim() ?? "";

			if (input === "list" || (!input && !ctx.hasUI)) {
				ctx.ui.notify([...runtime.instances.values()].map(describe).join("\n"), "info");
				return;
			}
			const add = input.match(/^add\s+(.+?)\s*=\s*(.+)$/);
			if (add) {
				await saveInstance(ctxUi(ctx), add[1].trim(), add[2].trim());
				return;
			}
			const remove = input.match(/^remove\s+(.+)$/);
			if (remove) {
				const target = findByName(remove[1].trim());
				if (!target) ctx.ui.notify(`No instance named "${remove[1].trim()}"`, "error");
				else removeInstance(ctxUi(ctx), target.id);
				return;
			}
			if (input) {
				ctx.ui.notify("Usage: /claude-setup [list | add <name> = <base command> | remove <name>]", "error");
				return;
			}

			// Interactive
			const ADD = "+ Add instance";
			const states = [...runtime.instances.values()];
			const choice = await ctx.ui.select("Claude CLI instances", [...states.map(describe), ADD]);
			if (!choice) return;

			if (choice === ADD) {
				await addWizard(ctxUi(ctx));
				return;
			}

			const state = states.find((s) => describe(s) === choice);
			if (!state) return;
			const { id, name, command } = state.instance;
			const action = await ctx.ui.select(name, ["Rename", "Change base command", "Remove", "Cancel"]);
			if (action === "Rename") {
				const newName = (await ctx.ui.input(`New name for "${name}" (empty keeps it)`, name))?.trim();
				if (newName && newName !== name) await saveInstance(ctxUi(ctx), newName, command, id);
			} else if (action === "Change base command") {
				const newCommand = (await ctx.ui.input(`Base command for "${name}" (empty keeps it)`, command))?.trim();
				if (newCommand && newCommand !== command) await saveInstance(ctxUi(ctx), name, newCommand, id);
			} else if (action === "Remove") {
				if (await ctx.ui.confirm(`Remove "${name}"?`, `Provider ${id} disappears from /model.`)) removeInstance(ctxUi(ctx), id);
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Other commands
	// ---------------------------------------------------------------------------

	pi.registerCommand("claude-usage", {
		description: "Show Claude plan usage limits (session, weekly, per-model) for every instance",
		handler: async (_arg, ctx) => {
			await refreshAll(ctx.cwd);
			const line = (label: string, percent: number, resetsAt: number | undefined) =>
				`  ${label.padEnd(18)} ${bar(percent)} ${percent.toFixed(1)}%${resetsAt ? ` · reset in ${formatDuration(resetsAt - Date.now())}` : ""}`;
			const blocks: string[] = [];
			for (const state of runtime.instances.values()) {
				const usage = state.usage;
				const lines = [describe(state)];
				if (!usage) {
					lines.push("  No usage limits available (API key login, older CLI or not reachable)");
				} else if (usage.limits && usage.limits.length > 0) {
					for (const l of usage.limits) {
						const scope = l.scope?.model?.display_name ?? l.scope?.surface;
						const label = `${l.group ?? l.kind}${scope ? ` (${scope})` : ""}`;
						lines.push(line(label, l.percent ?? 0, l.resets_at ? Date.parse(l.resets_at) : undefined));
					}
				} else {
					if (usage.session) lines.push(line("session", usage.session.percent, usage.session.resetsAt));
					if (usage.weekly) lines.push(line("weekly", usage.weekly.percent, usage.weekly.resetsAt));
				}
				blocks.push(lines.join("\n"));
			}
			ctx.ui.notify(blocks.join("\n\n"), "info");
			status.render(ctx);
		},
	});

	pi.registerCommand("claude-models", {
		description: "Reload the model lists from the Claude CLIs and show them",
		handler: async (_arg, ctx) => {
			const states = [...runtime.instances.values()];
			const results = await refreshAll(ctx.cwd);
			const blocks = states.map((state, i) => {
				const r = results[i];
				const head =
					r?.status === "rejected"
						? `${state.instance.name}: could not load models (${errorText(r.reason)})`
						: `${state.instance.name}: ${r?.value ? "updated" : "unchanged"}`;
				const list = withPinnedModels(state.models).map((m) => {
					const efforts = m.supportsEffort ? (m.supportedEffortLevels ?? []).join("/") : "no effort";
					const target = m.resolvedModel && m.resolvedModel !== m.value ? ` → ${m.resolvedModel}` : "";
					return `  ${state.instance.id}/${m.value}${target} (${efforts})`;
				});
				return [head, ...list].join("\n");
			});
			ctx.ui.notify(blocks.join("\n\n"), "info");
		},
	});

	pi.registerCommand("claude-mode", {
		description: `Set the Claude Code permission mode (${PERMISSION_MODES.join(", ")})`,
		handler: async (arg, ctx) => {
			let mode: string | undefined = arg?.trim();
			if (!mode && ctx.hasUI) mode = await ctx.ui.select("Claude Code permission mode", PERMISSION_MODES);
			if (!mode) return;
			if (!PERMISSION_MODES.includes(mode)) {
				ctx.ui.notify(`Unknown mode "${mode}". Use one of: ${PERMISSION_MODES.join(", ")}`, "error");
				return;
			}
			runtime.permissionMode = mode;
			publisher.status(ctx);
			ctx.ui.notify(`Claude Code permission mode: ${mode}`, "info");
		},
	});

	pi.registerCommand("claude-scratch", {
		description: "Show the scratch directory Claude Code uses for temporary files in this session",
		handler: async (_arg, ctx) => {
			ctx.ui.notify(`Scratch directory: ${scratchDir(ctx.sessionManager.getSessionId())}`, "info");
		},
	});

	pi.registerCommand("claude-new", {
		description: "Start fresh Claude Code sessions for the next prompt (replays the pi transcript)",
		handler: async (_arg, ctx) => {
			const id = ctx.sessionManager.getSessionId();
			forgetSessions([...runtime.instances.keys()].map((providerId) => sessionKey(providerId, id)));
			stopLiveRun();
			status.render(ctx);
			ctx.ui.notify("The next prompt starts a new Claude Code session.", "info");
		},
	});
}
