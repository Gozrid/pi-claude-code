/**
 * Antigravity provider for pi
 *
 * Registers one provider per configured agy instance ("antigravity", or
 * "antigravity-work", … for several accounts): every model request runs the
 * Antigravity CLI (`agy`) in print mode with stream-json output. agy works with its own
 * tools, sign-in, GEMINI.md/AGENTS.md rules and settings; pi shows its text and
 * tool activity live. One pi session maps to one agy conversation, continued
 * with --conversation on later prompts.
 *
 * The models come from `agy models` (Gemini, Claude, GPT-OSS, …). agy lists each
 * effort as a model of its own; pi gets one model per family and its thinking
 * level (or /effort) picks the variant. The list is cached, loaded at startup
 * and refreshed in the background.
 *
 * Only the connection to the CLI lives here. What the CLI does is published on
 * the event channels of ../shared/agent-bus.ts; agent-status-line, work-status,
 * permission-retry and chat-crab show it, and agent-status-line's Shift+Tab
 * switches the mode through MODE_CHANNEL.
 *
 * Usage:
 *   pi --model antigravity/gemini-4-argon   (or /model inside pi)
 *   /agy-add                                (wizard: add an instance for another account)
 *   /agy-setup [list | add <name> = <command> | remove <name>]
 *   /login                                  ("Antigravity CLI · …": add an instance or check one)
 *   /agy-mode [default|accept-edits|plan|auto|bypass]
 *   /agy-usage                              (plan usage limits; also in the agent-status-line extension)
 *   /agy-models                             (reload the model list from agy now)
 *   /agy-new                                (the next prompt starts a new agy conversation)
 *   /agy-scratch                            (show the session's scratch directory)
 *
 * Configuration (optional, written by the wizard): ~/.pi/agent/antigravity.json
 *   { "instances": [ { "id": "antigravity-work", "name": "Work", "command": "AGY_ADC_AUTH=1 agy" } ] }
 * Without instances there is one, "antigravity", running PI_AGY_BIN or "agy".
 *
 * Environment:
 *   PI_AGY_BIN          command of the default instance (default: "agy")
 *   PI_AGY_MODE         mode at start (default: agy's own agentMode setting, else "default")
 *   PI_AGY_EXTRA_ARGS   extra CLI args, whitespace separated
 *   PI_AGY_SCRATCH_DIR  base directory for per-session scratch dirs (default: system temp)
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	ACTIVITY_CHANNEL,
	type ActivityEvent,
	type AgentStatus,
	DENIALS_CHANNEL,
	type DenialsEvent,
	MODE_CHANNEL,
	type ModeRequest,
	ONESHOT_CHANNEL,
	type OneShotRequest,
	STATUS_CHANNEL,
	type StatusEvent,
	TOOL_CHANNEL,
	BRIDGE_CHANNEL,
	type BridgeRequest,
	type BridgeServerInfo,
	type UsageAccount,
	USAGE_CHANNEL,
	USAGE_REFRESH_CHANNEL,
	type UsageEvent,
	type UsageRefreshRequest,
	SUBAGENTS_CHANNEL,
	type SubagentsEvent,
} from "../shared/agent-bus.ts";
import { formatDuration } from "../shared/format.ts";
import { type AgyModel, loadCachedModels, queryModels, queryUsage, saveCachedModels, toProviderModel } from "./cli.ts";
import {
	AGY_DIR,
	AGY_SETTINGS_FILE,
	API_PREFIX,
	CONFIG_FILE,
	DEFAULT_PROVIDER_ID,
	type Instance,
	loadConfiguredInstances,
	loadInstances,
	providerIdFor,
	saveInstances,
} from "./config.ts";
import { oneShot } from "./oneshot.ts";
import { allowRules } from "./permissions.ts";
import { type InstanceState, isAntigravityProvider, MODE_CYCLE, MODES, runtime } from "./state.ts";
import { contextFor, forgetSessions, loadSessions, scratchDir, sessionKey, streamAntigravity } from "./stream.ts";
import { AgySubagentWatcher } from "./subagents.ts";
import { bar, usageForModel, usageWindows } from "./usage.ts";
import { ctxUi, oauthUi, type Probe, runAddWizard, signInHint, type WizardUi } from "./wizard.ts";

/** Source name on the channels. */
const SOURCE = "antigravity";

/** Shown until `agy models` answered once. */
const FALLBACK_MODELS: AgyModel[] = [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] }];

/** Provider that only exists to put "add another account" into /login. */
const SETUP_PROVIDER_ID = "antigravity-cli-setup";

/** Chat note: Escape ended agy while tool steps (e.g. a background command it waited for) still ran. */
const STOPPED_MESSAGE = "antigravity-stopped";

/** What pi stores after a /login: agy keeps its own sign-in, pi only needs a credential that never expires. */
function cliCredentials() {
	return { access: "agy-cli", refresh: "agy-cli", expires: Date.now() + 10 * 365 * 24 * 3600_000 };
}

function newInstanceState(instance: Instance): InstanceState {
	return { instance, models: loadCachedModels(instance.id) ?? FALLBACK_MODELS };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------------------
	// Instances and their providers
	// ---------------------------------------------------------------------------

	/** Reads plan usage from one agy and republishes the status line when available. */
	const refreshUsage = async (state: InstanceState, cwd: string): Promise<void> => {
		const usage = await queryUsage(state.instance.command, cwd);
		if (usage) {
			state.usage = usage;
			publish();
			publishUsage();
		}
	};

	/** Plan usage of every instance, for usage-graph. */
	const publishUsage = () => {
		const accounts = [...runtime.instances.values()].flatMap((state): UsageAccount[] => {
			const windows = usageWindows(state.usage);
			return windows.length > 0 ? [{ id: state.instance.id, name: `Antigravity · ${state.instance.name}`, windows }] : [];
		});
		pi.events.emit(USAGE_CHANNEL, { source: SOURCE, accounts } satisfies UsageEvent);
	};

	// usage-graph asks for fresh usage of every account.
	pi.events.on(USAGE_REFRESH_CHANNEL, (data) => {
		const request = data as UsageRefreshRequest;
		const states = [...runtime.instances.values()];
		request.pending(Promise.allSettled(states.map((state) => refreshUsage(state, request.cwd || runtime.cwd))));
	});

	/** Reads the model list and plan usage from one agy again; resolves true when the models changed. */
	const refresh = (state: InstanceState, cwd: string): Promise<boolean> => {
		state.discovery ??= Promise.all([queryModels(state.instance.command, cwd), refreshUsage(state, cwd)])
			.then(([models]) => applyModels(state, models))
			.finally(() => {
				state.discovery = undefined;
			});
		return state.discovery;
	};

	const refreshAll = (cwd: string) =>
		Promise.allSettled([...runtime.instances.values()].map((state) => refresh(state, cwd)));

	/** /login for an instance: agy signs in by itself, so this checks that the command answers. */
	const checkInstance = async (state: InstanceState, ui: WizardUi): Promise<void> => {
		ui.progress(`Checking ${state.instance.command} …`);
		try {
			await refresh(state, runtime.cwd);
		} catch (error) {
			throw new Error(`${state.instance.name}: ${errorText(error)}\n${signInHint(state.instance.command)}`);
		}
		ui.progress(`${state.instance.name}: ${state.models.length} models`);
	};

	const register = (state: InstanceState) => {
		const { id, name } = state.instance;
		pi.registerProvider(id, {
			// Shown in /model and /login; the shared prefix keeps all instances together in /login.
			name: `Antigravity CLI · ${name}`,
			baseUrl: "cli://agy",
			// agy signs in by itself; pi only needs a non-empty key to send requests.
			apiKey: "agy-cli",
			// One API id per instance, so unregistering one provider leaves the others' stream in place.
			api: `${API_PREFIX}:${id}`,
			models: state.models.map((m) => toProviderModel(m, id === DEFAULT_PROVIDER_ID ? undefined : name)),
			streamSimple: streamAntigravity,
			// Lists the instance in /login, to check that its agy answers.
			oauth: {
				name: `Antigravity CLI · ${name}`,
				isSubscription: true,
				login: async (callbacks) => {
					const current = runtime.instances.get(id);
					if (!current) throw new Error(`No Antigravity CLI instance "${name}"`);
					await checkInstance(current, oauthUi(callbacks));
					return cliCredentials();
				},
				refreshToken: async (credentials) => ({ ...credentials, expires: cliCredentials().expires }),
				getApiKey: () => "agy-cli",
			},
		});
	};

	const applyModels = (state: InstanceState, models: AgyModel[]): boolean => {
		saveCachedModels(state.instance.id, models);
		if (JSON.stringify(models) === JSON.stringify(state.models)) return false;
		state.models = models;
		if (runtime.instances.get(state.instance.id) === state) register(state);
		return true;
	};

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
			const state = runtime.instances.get(instance.id) ?? newInstanceState(instance);
			state.instance = instance;
			runtime.instances.set(instance.id, state);
			register(state);
		}
	};

	applyInstances(loadInstances());

	// ---------------------------------------------------------------------------
	// Event channels
	// ---------------------------------------------------------------------------

	let current: ExtensionContext | undefined;

	const statusData = (ctx: ExtensionContext): AgentStatus | undefined => {
		const model = ctx.model;
		const state = model ? runtime.instances.get(model.provider) : undefined;
		if (!model || !state) return undefined;
		const effort = pi.getThinkingLevel();
		const key = sessionKey(model.provider, ctx.sessionManager.getSessionId());
		const tokens = contextFor(key)?.tokens ?? ctx.getContextUsage()?.tokens ?? 0;
		const window = state.instance.contextWindow;
		const { session, weekly } = usageForModel(state.usage, model.id);
		return {
			provider: model.provider,
			mode: runtime.mode,
			model: state.models.find((m) => m.id === model.id)?.name ?? model.id,
			instance: runtime.instances.size > 1 ? state.instance.name : undefined,
			effort: model.reasoning && effort && effort !== "off" ? effort : undefined,
			context: window || tokens ? { tokens, window } : undefined,
			session: session && { percent: session.percent, resetsAt: session.resetsAt },
			weekly: weekly && { percent: weekly.percent },
		};
	};

	/** Publishes the status of the given context, or of the last one seen. */
	const publish = (ctx: ExtensionContext | undefined = current) => {
		if (!ctx?.hasUI) return;
		current = ctx;
		try {
			pi.events.emit(STATUS_CHANNEL, { source: SOURCE, status: statusData(ctx) } satisfies StatusEvent);
		} catch {
			// The context went stale (reload or session switch); the next event brings a fresh one.
			current = undefined;
		}
	};

	runtime.onUsage = () => publish();
	runtime.onTool = (event) => pi.events.emit(TOOL_CHANNEL, event);
	// The note lands after the aborted turn; agy learns it with the next prompt.
	runtime.onToolsStopped = (descriptions) => {
		const list = descriptions.map((d) => `"${d}"`).join(", ");
		const content = `Antigravity was stopped; ${descriptions.length === 1 ? "this step was still running and ended" : "these steps were still running and ended"}: ${list}.`;
		pi.sendMessage({ customType: STOPPED_MESSAGE, content, display: true }, { triggerTurn: false });
	};
	pi.registerMessageRenderer(STOPPED_MESSAGE, (message, _options, theme) => new Text(theme.fg("warning", `⚠ ${String(message.content)}`), 0, 0));
	runtime.onActivity = (provider, activity) => pi.events.emit(ACTIVITY_CHANNEL, { provider, activity } satisfies ActivityEvent);
	runtime.piTools = () => pi.getAllTools();
	runtime.bridge = (provider) => {
		let server: BridgeServerInfo | undefined;
		pi.events.emit(BRIDGE_CHANNEL, {
			provider,
			kind: "agy",
			cwd: runtime.cwd,
			agySettings: AGY_SETTINGS_FILE,
			mode: runtime.skipPermissionsOnce ? "bypass" : runtime.mode,
			reply: (info) => {
				server = info;
			},
		} satisfies BridgeRequest);
		return server;
	};

	pi.events.on(ONESHOT_CHANNEL, (data) => {
		const request = data as OneShotRequest;
		if (!isAntigravityProvider(request?.provider)) return;
		request.claim();
		void oneShot(request.provider, request.system, request.prompt).then(request.reply, () => request.reply(undefined));
	});

	const setMode = (mode: string) => {
		runtime.mode = mode;
		publish();
	};

	// Shift+Tab in agent-status-line: the next mode of the cycle, or the one asked for.
	pi.events.on(MODE_CHANNEL, (data) => {
		const request = data as ModeRequest;
		if (!isAntigravityProvider(request?.provider)) return;
		const next = request.mode ?? MODE_CYCLE[(MODE_CYCLE.indexOf(runtime.mode) + 1) % MODE_CYCLE.length];
		if (MODES.includes(next)) setMode(next);
	});

	/** Actions agy was not allowed to take: permission-retry offers to allow them and retry. */
	const publishDenials = (ctx: ExtensionContext) => {
		const denials = runtime.denials;
		runtime.denials = undefined;
		const provider = ctx.model?.provider;
		if (!denials || !provider || !isAntigravityProvider(provider)) return;
		const rules = [...new Set(denials.items.map((item) => item.rule).filter((rule): rule is string => !!rule))];
		const writes = denials.items.some((item) => item.action === "write_file" || item.tool === "Write" || item.tool === "Edit");
		const event: DenialsEvent = {
			provider,
			mode: denials.mode,
			items: denials.items.map(({ tool, detail }) => ({ tool, detail })),
			choices: [
				...(writes && denials.mode !== "accept-edits" && denials.mode !== "bypass"
					? [{ label: "Switch to accept edits and retry", apply: () => setMode("accept-edits") }]
					: []),
				...(rules.length > 0
					? [
							{
								label: `Always allow ${rules.join(", ")} and retry`,
								apply: () => {
									if (!allowRules(rules)) ctx.ui.notify(`Could not write ${AGY_SETTINGS_FILE}`, "error");
								},
							},
						]
					: []),
				{
					label: "Allow everything this once and retry",
					apply: () => {
						runtime.skipPermissionsOnce = true;
					},
				},
			],
		};
		pi.events.emit(DENIALS_CHANNEL, event);
	};

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	let ticker: ReturnType<typeof setInterval> | undefined;

	// The subagents of the selected instance's agy conversation, for the subagents extension.
	const watcher = new AgySubagentWatcher(process.env.PI_AGY_BRAIN_DIR || join(AGY_DIR, "brain"));
	let watching: ReturnType<typeof setInterval> | undefined;
	const conversation = (): string | undefined => {
		let provider: string | undefined;
		try {
			provider = current?.model?.provider;
		} catch {
			return undefined;
		}
		if (!provider || !isAntigravityProvider(provider) || !runtime.sessionId) return undefined;
		const key = sessionKey(provider, runtime.sessionId);
		return (runtime.live?.key === key ? runtime.live.conversationId : undefined) ?? loadSessions()[key]?.conversationId;
	};
	const pollSubagents = () => {
		let agents;
		try {
			agents = watcher.poll(conversation(), runtime.live !== undefined);
		} catch {
			return;
		}
		if (agents) pi.events.emit(SUBAGENTS_CHANNEL, { source: SOURCE, agents } satisfies SubagentsEvent);
	};

	pi.on("session_start", async (_event, ctx) => {
		runtime.sessionId = ctx.sessionManager.getSessionId();
		runtime.cwd = ctx.cwd;
		runtime.projectTrusted = ctx.isProjectTrusted();
		publish(ctx);
		// In the background, so startup is not held up by agy.
		void refreshAll(ctx.cwd);
		if (ctx.hasUI && !ticker) {
			let ticks = 0;
			ticker = setInterval(() => {
				publish();
				// Every 5 minutes, pick up usage from other agy sessions while pi is idle.
				const state = current?.model ? runtime.instances.get(current.model.provider) : undefined;
				if (++ticks % 10 === 0 && state && current?.isIdle()) void refreshUsage(state, current.cwd);
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
		publish(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		publish(ctx);
		publishDenials(ctx);
		const state = ctx.model ? runtime.instances.get(ctx.model.provider) : undefined;
		if (state) void refreshUsage(state, ctx.cwd);
	});
	pi.on("model_select", async (_event, ctx) => {
		publish(ctx);
		pollSubagents();
	});
	pi.on("thinking_level_select", async (_event, ctx) => publish(ctx));
	pi.on("turn_end", async (_event, ctx) => publish(ctx));
	pi.on("agent_settled", async (_event, ctx) => publish(ctx));
	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (watching) clearInterval(watching);
		watching = undefined;
		current = undefined;
	});

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	pi.registerCommand("agy-usage", {
		description: "Show Antigravity plan usage limits (5-hour and weekly buckets) for every instance",
		handler: async (_arg, ctx) => {
			await Promise.allSettled([...runtime.instances.values()].map((state) => refreshUsage(state, ctx.cwd)));
			const line = (label: string, percent: number, resetsAt: number | undefined) =>
				`  ${label.padEnd(30)} ${bar(percent)} ${percent.toFixed(1)}%${resetsAt ? ` · reset in ${formatDuration(resetsAt - Date.now())}` : ""}`;
			const blocks: string[] = [];
			for (const state of runtime.instances.values()) {
				const usage = state.usage;
				const lines = [describe(state)];
				if (!usage || usage.groups.length === 0) {
					lines.push("  No usage limits available (API key login, older CLI or not reachable)");
				} else {
					for (const group of usage.groups) {
						for (const bucket of group.buckets) {
							const label = `${group.name} (${bucket.window || bucket.name})`;
							lines.push(line(label, bucket.percent, bucket.resetsAt));
						}
					}
				}
				blocks.push(lines.join("\n"));
			}
			ctx.ui.notify(blocks.join("\n\n"), "info");
			publish(ctx);
		},
	});

	pi.registerCommand("agy-mode", {
		description: `Set the Antigravity mode (${MODES.join(", ")})`,
		getArgumentCompletions: (prefix) =>
			MODES.filter((m) => m.startsWith(prefix.trim())).map((m) => ({ value: m, label: m })),
		handler: async (arg, ctx) => {
			let mode: string | undefined = arg?.trim();
			if (!mode && ctx.hasUI) mode = await ctx.ui.select("Antigravity mode", MODES);
			if (!mode) return;
			if (!MODES.includes(mode)) {
				ctx.ui.notify(`Unknown mode "${mode}". Use one of: ${MODES.join(", ")}`, "error");
				return;
			}
			runtime.mode = mode;
			publish(ctx);
			ctx.ui.notify(`Antigravity mode: ${mode}`, "info");
		},
	});

	pi.registerCommand("agy-models", {
		description: "Reload the model lists from the Antigravity CLIs and show them",
		handler: async (_arg, ctx) => {
			const states = [...runtime.instances.values()];
			const results = await refreshAll(ctx.cwd);
			const blocks = states.map((state, i) => {
				const r = results[i];
				const head =
					r?.status === "rejected"
						? `${state.instance.name}: could not load models (${errorText(r.reason)})`
						: `${state.instance.name}: ${r?.value ? "updated" : "unchanged"}`;
				const list = state.models.map(
					(m) => `  ${state.instance.id}/${m.id} (${m.efforts.length > 1 ? m.efforts.join("/") : "no effort levels"})`,
				);
				return [head, ...list].join("\n");
			});
			ctx.ui.notify(blocks.join("\n\n"), "info");
		},
	});

	pi.registerCommand("agy-new", {
		description: "Start a new Antigravity conversation with the next prompt (replays the pi transcript)",
		handler: async (_arg, ctx) => {
			const id = ctx.sessionManager.getSessionId();
			forgetSessions([...runtime.instances.keys()].map((providerId) => sessionKey(providerId, id)));
			publish(ctx);
			ctx.ui.notify("The next prompt starts a new Antigravity conversation.", "info");
		},
	});

	pi.registerCommand("agy-scratch", {
		description: "Show the scratch directory Antigravity uses for temporary files in this session",
		handler: async (_arg, ctx) => {
			ctx.ui.notify(`Scratch directory: ${scratchDir(ctx.sessionManager.getSessionId())}`, "info");
		},
	});

	// ---------------------------------------------------------------------------
	// /agy-setup and /login: manage CLI instances
	// ---------------------------------------------------------------------------

	const describe = (state: InstanceState) => `${state.instance.name} → ${state.instance.id}/… · ${state.instance.command}`;

	/** Tests a base command by asking that agy for its models. */
	const probe = async (command: string): Promise<Probe> => {
		try {
			return { models: await queryModels(command, runtime.cwd) };
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
			tested = await probe(command);
			if (tested.error) {
				const keep =
					ui.interactive &&
					(await ui.confirm(
						`"${command}" did not answer`,
						`${tested.error}\n\n${signInHint(command)}\n\nSave this instance anyway?`,
					));
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
		if (tested.models) applyModels(state, tested.models);
		const models = tested.models ? `${state.models.length} models` : "not reachable yet";
		ui.notify(
			`${existingId ? "Updated" : "Added"} ${describe(state)}\n${models}. Pick its models with /model (provider ${target.id}).`,
			"info",
		);
		publish();
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
		publish();
	};

	const findByName = (name: string) =>
		[...runtime.instances.values()]
			.map((s) => s.instance)
			.find((i) => i.name.toLowerCase() === name.toLowerCase() || i.id === name);

	const addWizard = (ui: WizardUi) =>
		runAddWizard(ui, {
			configured: loadConfiguredInstances(),
			probe,
			save: (wizardUi, name, command, tested) => saveInstance(wizardUi, name, command, undefined, tested),
		});

	pi.registerCommand("agy-add", {
		description: "Wizard: add an Antigravity CLI instance (agy's sign-in, Application Default Credentials or own command)",
		handler: async (_arg, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The wizard needs the interactive UI. Use: /agy-setup add <name> = <base command>", "error");
				return;
			}
			await addWizard(ctxUi(ctx));
		},
	});

	// "Add another account" in /login runs the same wizard through pi's login dialogs.
	pi.registerProvider(SETUP_PROVIDER_ID, {
		name: "Antigravity CLI · add another account…",
		baseUrl: "cli://agy",
		apiKey: "agy-cli",
		api: `${API_PREFIX}:setup`,
		models: [],
		streamSimple: streamAntigravity,
		oauth: {
			name: "Antigravity CLI · add another account…",
			isSubscription: true,
			login: async (callbacks) => {
				const saved = await addWizard(oauthUi(callbacks));
				if (!saved) throw new Error("No Antigravity CLI instance was added");
				return cliCredentials();
			},
			refreshToken: async (credentials) => ({ ...credentials, expires: cliCredentials().expires }),
			getApiKey: () => "agy-cli",
		},
	});

	pi.registerCommand("agy-setup", {
		description: "Manage Antigravity CLI instances: list | add <name> = <command> | remove <name> (no args: interactive)",
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
				ctx.ui.notify("Usage: /agy-setup [list | add <name> = <base command> | remove <name>]", "error");
				return;
			}

			// Interactive
			const ADD = "+ Add instance";
			const states = [...runtime.instances.values()];
			const choice = await ctx.ui.select("Antigravity CLI instances", [...states.map(describe), ADD]);
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
}
