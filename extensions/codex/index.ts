import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ctxUi, oauthUi, type WizardUi } from "../shared/account-ui.ts";
import {
	ACTIVITY_CHANNEL,
	DENIALS_CHANNEL,
	MODE_CHANNEL,
	ONESHOT_CHANNEL,
	STATUS_CHANNEL,
	SUBAGENTS_CHANNEL,
	SUPER_AGENT_CHANNEL,
	TASKS_CHANNEL,
	TOOL_CHANNEL,
	USAGE_CHANNEL,
	USAGE_REFRESH_CHANNEL,
	type AgentStatus,
	type DenialsEvent,
	type ModeRequest,
	type OneShotRequest,
	type Subagent,
	type SuperAgentRequest,
	type Task,
	type UsageLimitWindow,
	type UsageRefreshRequest,
} from "../shared/agent-bus.ts";
import { appendStep, SuperAgentList, trimLive } from "../shared/super-agents.ts";
import {
	accountWindows,
	cachedModels,
	configured,
	credentials,
	defaultInstance,
	selectable,
	instanceId,
	listModels,
	login,
	oauthLogin,
	providerModel,
	saveInstances,
	saveModels,
	scratchDir,
	windows,
	type CliModel,
	type Instance,
} from "./accounts.ts";
import { CodexClient, withClient } from "./client.ts";
import { MODES } from "./protocol.ts";
import { streamTurn } from "./stream.ts";
import { runTurn, type TurnEvents, type TurnOptions } from "./turn.ts";

const SOURCE = "codex-cli";
const RESET = "codex-cli-new";
const SNAPSHOT = "codex-cli-state";
interface Account {
	instance: Instance;
	models: CliModel[];
	limits: UsageLimitWindow[];
	discovery?: Promise<void>;
}
interface SessionView {
	tasks: Task[];
	agents: Map<string, Subagent>;
	context?: AgentStatus["context"];
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function (pi: ExtensionAPI) {
	const accounts = new Map<string, Account>();
	const views = new Map<string, SessionView>();
	let current: ExtensionContext;
	let mode = MODES.includes(process.env.PI_CODEX_MODE ?? "") ? process.env.PI_CODEX_MODE! : "default";
	let steer: Parameters<NonNullable<TurnEvents["ready"]>>[0] | undefined;
	let shutdown = new AbortController();
	let idle: { key: string; client: CodexClient } | undefined;
	let denial: DenialsEvent | undefined;
	const closeIdle = () => {
		idle?.client.close();
		idle = undefined;
	};
	const superAgents = new SuperAgentList((agents) => pi.events.emit(SUBAGENTS_CHANNEL, { source: SOURCE + ":super", agents }));
	const session = () => current.sessionManager.getSessionId();
	const view = (id: string) => {
		const key = session() + "/" + id;
		const v = views.get(key) ?? { tasks: [], agents: new Map<string, Subagent>() };
		views.set(key, v);
		return v;
	};
	const restoreViews = (ctx: ExtensionContext) => {
		views.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === RESET) views.clear();
			if (entry.customType !== SNAPSHOT) continue;
			const saved = entry.data as { provider: string; tasks: Task[]; agents: Subagent[]; context?: AgentStatus["context"] };
			if (saved?.provider && Array.isArray(saved.tasks) && Array.isArray(saved.agents)) {
				views.set(session() + "/" + saved.provider, {
					tasks: saved.tasks,
					agents: new Map(saved.agents.map((a) => [a.id, a])),
					context: saved.context,
				});
			}
		}
	};
	const publishStatus = () => {
		const model = current?.model;
		const a = model && accounts.get(model.provider);
		const status: AgentStatus | undefined =
			a && model
				? {
						provider: a.instance.id,
						model: a.models.find((m) => m.id === model.id)?.name ?? model.name,
						mode,
						instance: accounts.size > 1 ? a.instance.name : undefined,
						effort: model.reasoning ? pi.getThinkingLevel() : undefined,
						context: view(a.instance.id).context,
						session: a.limits.find((w) => w.id === "primary"),
						weekly: a.limits.find((w) => w.id === "secondary"),
					}
				: undefined;
		pi.events.emit(STATUS_CHANNEL, { source: SOURCE, status });
	};
	const publishPanels = () => {
		const id = current?.model?.provider;
		const data = id && accounts.has(id) ? view(id) : undefined;
		pi.events.emit(TASKS_CHANNEL, { source: SOURCE, tasks: data?.tasks ?? [] });
		pi.events.emit(SUBAGENTS_CHANNEL, { source: SOURCE, agents: [...(data?.agents.values() ?? [])] });
	};
	const publishUsage = () => {
		pi.events.emit(USAGE_CHANNEL, {
			source: SOURCE,
			accounts: [...accounts.values()]
				.filter((a) => a.limits.length)
				.map((a) => ({ id: a.instance.id, name: "Codex · " + a.instance.name, windows: a.limits })),
		});
		publishStatus();
	};
	const refresh = (a: Account, cwd: string) => {
		a.discovery ??= withClient(a.instance.command, cwd, async (client) => {
			const usage = client
				.request("account/rateLimits/read")
				.then((v) => {
					if (accounts.get(a.instance.id) === a) {
						a.limits = accountWindows(v);
						publishUsage();
					}
				})
				.catch(() => {});
			const models = await listModels(client);
			if (accounts.get(a.instance.id) === a && JSON.stringify(models) !== JSON.stringify(a.models)) {
				a.models = models;
				register(a);
				saveModels(a.instance, models);
			}
			await usage;
		}).finally(() => {
			a.discovery = undefined;
		});
		return a.discovery;
	};
	const register = (a: Account) => {
		const i = a.instance;
		pi.registerProvider(i.id, {
			name: "Codex CLI · " + i.name,
			baseUrl: "cli://codex",
			apiKey: SOURCE,
			api: SOURCE + ":" + i.id,
			models: selectable(a.models).map((m) => providerModel(i, m)),
			oauth: {
				name: "Codex CLI · " + i.name,
				isSubscription: true,
				login: async (cb) => {
					await oauthLogin(i, current?.cwd ?? process.cwd(), cb);
					await refresh(a, current?.cwd ?? process.cwd());
					return credentials();
				},
				refreshToken: async () => credentials(),
				getApiKey: () => SOURCE,
			},
			streamSimple: (model, context, options) => {
				const ctx = current;
				const provider = i.id;
				const data = view(provider);
				const key = JSON.stringify([session(), ctx.cwd, i.id, i.command, mode]);
				const client = idle?.key === key && !idle.client.signal.aborted ? idle.client : new CodexClient(i.command, ctx.cwd);
				if (idle?.client !== client) closeIdle();
				idle = undefined;
				const refused: DenialsEvent["items"] = [];
				const reset = ctx.sessionManager
					.getBranch()
					.filter((x) => x.type === "custom" && x.customType === RESET)
					.at(-1);
				const opts: TurnOptions = {
					pi,
					ctx,
					context,
					instance: i,
					park:
						ctx.mode !== "tui" && ctx.mode !== "rpc"
							? undefined
							: (client) => {
									idle = { key, client };
								},
					background: (content) =>
						pi.sendMessage({ customType: "codex-background", content, display: true }, { triggerTurn: false }),
					model: model.id,
					effort: options?.reasoning && (model.thinkingLevelMap?.[options.reasoning] ?? undefined),
					mode,
					session: options?.sessionId ?? session(),
					reset: reset ? Date.parse(reset.timestamp) : 0,
					signal: AbortSignal.any([shutdown.signal, ...(options?.signal ? [options.signal] : [])]),
				};
				let tokens = 0;
				const activity = (value?: Parameters<NonNullable<TurnEvents["activity"]>>[0]) =>
					pi.events.emit(ACTIVITY_CHANNEL, { provider, activity: value && { ...value, tokens } });
				activity({ phase: "starting" });
				const stream = streamTurn(model, opts, client, {
					denied(tool, detail) {
						refused.push({ tool, detail });
					},
					activity,
					ready(fn) {
						steer = fn;
					},
					tool(event) {
						pi.events.emit(TOOL_CHANNEL, event);
					},
					limits(snapshot) {
						if (!snapshot?.limitId || snapshot.limitId === "codex") {
							a.limits = [...windows(snapshot), ...a.limits.filter((w) => w.id.includes("/"))];
							publishUsage();
						}
					},
					usage(last, _total, window) {
						tokens = last.outputTokens;
						data.context = { tokens: last.totalTokens, window };
						publishStatus();
					},
					tasks(tasks) {
						data.tasks = tasks;
						publishPanels();
					},
					agents(agent) {
						data.agents.set(agent.id, agent);
						publishPanels();
					},
				});
				void stream.result().then((out) => {
					steer = undefined;
					activity();
					if (out.stopReason === "stop" && refused.length && opts.mode !== "full-access")
						denial = {
							provider,
							mode: opts.mode,
							items: refused,
							choices: [
								{
									label: "Retry in workspace-write mode and ask for additional access",
									apply: () => {
										mode = "workspace-write";
										publishStatus();
									},
								},
							],
						};
				});
				return stream;
			},
		});
	};
	const sync = () => {
		const saved = configured();
		const next = saved.length ? saved : [defaultInstance()];
		for (const id of accounts.keys())
			if (!next.some((i) => i.id === id)) {
				pi.unregisterProvider(id);
				accounts.delete(id);
			}
		for (const i of next) {
			const a = accounts.get(i.id);
			if (a && a.instance.command === i.command && a.instance.name === i.name) continue;
			const account: Account = { instance: i, models: cachedModels(i), limits: [] };
			accounts.set(i.id, account);
			register(account);
		}
	};
	sync();
	const save = (i: Instance) => {
		const saved = configured().filter((a) => a.id !== i.id);
		saveInstances([...saved, i]);
		sync();
		void refresh(accounts.get(i.id)!, current.cwd).catch(() => {});
	};
	const add = async (ui: WizardUi, cb?: OAuthLoginCallbacks) => {
		const name = (await ui.input("Codex account name", "e.g. Work"))?.trim();
		if (!name) return false;
		if (configured().some((i) => i.name.toLowerCase() === name.toLowerCase()))
			throw new Error("An account already has this name.");
		const options = ["Use my current Codex login", "Sign in a separate ChatGPT account", "Enter a base command"];
		const choice = await ui.select("Account for " + name, options);
		if (!choice) return false;
		const id = instanceId(name, configured());
		let command = defaultInstance().command;
		if (choice === options[1]) {
			const folder = ".codex-" + id.slice("codex-cli-".length);
			mkdirSync(join(homedir(), folder), { recursive: true, mode: 0o700 });
			command = 'CODEX_HOME="$HOME/' + folder + '" codex';
			await login(
				{ id, name, command },
				current.cwd,
				(url) => (cb ? cb.onAuth({ url }) : ui.notify("Open this link to sign in:\n" + url)),
				cb?.signal ?? shutdown.signal,
			);
		} else if (choice === options[2]) {
			const custom = (await ui.input("Base command", "codex --profile work"))?.trim();
			if (!custom) return false;
			command = custom;
		}
		await withClient(command, current.cwd, listModels);
		save({ id, name, command });
		ui.notify("Pick " + id + " in /model.");
		return true;
	};
	pi.registerProvider("codex-account-setup", {
		name: "Codex CLI · add another account…",
		baseUrl: "cli://codex",
		apiKey: SOURCE,
		models: [],
		oauth: {
			name: "Codex CLI · add another account…",
			isSubscription: true,
			login: async (cb) => {
				if (!(await add(oauthUi(cb), cb))) throw new Error("Codex setup cancelled");
				return credentials();
			},
			refreshToken: async () => credentials(),
			getApiKey: () => SOURCE,
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		shutdown = new AbortController();
		restoreViews(ctx);
		publishStatus();
		publishPanels();
		publishUsage();
		for (const a of accounts.values()) void refresh(a, ctx.cwd).catch(() => {});
	});
	pi.on("model_select", async (_e, ctx) => {
		closeIdle();
		current = ctx;
		publishStatus();
		publishPanels();
	});
	pi.on("session_tree", async (_e, ctx) => {
		closeIdle();
		current = ctx;
		restoreViews(ctx);
		publishStatus();
		publishPanels();
	});
	pi.on("agent_start", async (_e, ctx) => {
		current = ctx;
		publishStatus();
	});
	pi.on("thinking_level_select", async (_e, ctx) => {
		current = ctx;
		publishStatus();
	});
	pi.on("session_shutdown", async () => {
		shutdown.abort();
		closeIdle();
		steer = undefined;
		superAgents.stopAll();
		superAgents.clearFinished();
		views.clear();
	});
	pi.on("agent_end", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider && accounts.has(provider)) {
			const data = view(provider);
			pi.appendEntry(SNAPSHOT, { provider, tasks: data.tasks, agents: [...data.agents.values()], context: data.context });
		}
		superAgents.stopAll();
		if (denial) pi.events.emit(DENIALS_CHANNEL, denial);
		denial = undefined;
	});
	pi.on("input", async (event, ctx) => {
		if (
			steer &&
			accounts.has(ctx.model?.provider ?? "") &&
			event.streamingBehavior === "steer" &&
			!event.text.trimStart().startsWith("/")
		) {
			try {
				await steer(event.text, event.images);
				return { action: "handled" };
			} catch {
				/* a turn already over: let pi queue it */
			}
		}
		return { action: "continue" };
	});
	pi.events.on(MODE_CHANNEL, (data) => {
		const r = data as ModeRequest;
		if (!accounts.has(r.provider)) return;
		const cycle = MODES.slice(0, 4);
		const next = r.mode ?? cycle[(cycle.indexOf(mode) + 1) % cycle.length];
		if (MODES.includes(next)) {
			mode = next;
			publishStatus();
		}
	});
	pi.events.on(USAGE_REFRESH_CHANNEL, (data) => {
		const r = data as UsageRefreshRequest;
		r.pending(Promise.allSettled([...accounts.values()].map((a) => refresh(a, r.cwd))));
	});
	const auxiliary = (
		account: Account,
		kind: "title" | "super",
		prompt: string,
		model: string,
		hooks: TurnEvents,
		signal: AbortSignal,
		system?: string,
	) => {
		const client = new CodexClient(account.instance.command, current.cwd);
		return runTurn(
			client,
			{
				pi,
				ctx: current,
				instance: account.instance,
				model,
				mode,
				reset: 0,
				kind,
				system,
				session: session(),
				context: { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				signal: AbortSignal.any([signal, shutdown.signal]),
			},
			hooks,
		).finally(() => client.close());
	};
	pi.events.on(ONESHOT_CHANNEL, (data) => {
		const r = data as OneShotRequest;
		const a = accounts.get(r.provider);
		if (!a) return;
		r.claim();
		const model = a.models.find((m) => /mini|nano|luna/i.test(m.id))?.id ?? a.models[0]?.id ?? "default";
		let text = "";
		void auxiliary(
			a,
			"title",
			r.prompt,
			model,
			{
				delta() {},
				end() {},
				answer(s) {
					text = s;
				},
			},
			AbortSignal.timeout(60_000),
			r.system,
		).then(
			() => r.reply(text),
			() => r.reply(undefined),
		);
	});
	pi.events.on(SUPER_AGENT_CHANNEL, (data) => {
		const r = data as SuperAgentRequest;
		const a = accounts.get(r.provider);
		if (!a) return;
		r.claim();
		const controller = new AbortController();
		const agent = superAgents.add(r.description, "Codex", r.prompt, () => controller.abort());
		const model = r.model ?? current.model?.id ?? "default";
		let answer = "",
			lastKey = "";
		const signal = AbortSignal.any([controller.signal, ...(r.signal ? [r.signal] : [])]);
		void auxiliary(
			a,
			"super",
			r.prompt,
			model,
			{
				delta(key, kind, text) {
					appendStep(agent.steps, kind, text, lastKey !== key);
					lastKey = key;
					trimLive(agent.steps);
					superAgents.changed();
				},
				end() {
					lastKey = "";
				},
				answer(text) {
					answer = text;
				},
			},
			signal,
		).then(
			(v) => {
				superAgents.finish(agent, true);
				r.reply({ text: answer, model, session: v.thread, isError: false });
			},
			(error) => {
				superAgents.finish(agent, false);
				r.reply({ text: errorText(error), isError: true });
			},
		);
	});

	pi.registerCommand("codex-add", {
		description: "Add a Codex CLI account",
		handler: async (_arg, ctx) => {
			await add(ctxUi(ctx));
		},
	});
	pi.registerCommand("codex-setup", {
		description: "Manage Codex accounts: list | add <name> = <command> | remove <name>",
		handler: async (arg, ctx) => {
			const values = [...accounts.values()].map((a) => a.instance);
			const lines = values.map((i) => i.name + " · " + i.id + " · " + i.command);
			const input = arg.trim();
			const match = /^add\s+(.+?)\s*=\s*(.+)$/.exec(input);
			if (match) {
				const name = match[1].trim(),
					command = match[2].trim();
				if (configured().some((i) => i.name.toLowerCase() === name.toLowerCase()))
					throw new Error("An account already has this name.");
				await withClient(command, ctx.cwd, listModels);
				save({ name, command, id: instanceId(name, configured()) });
				return;
			}
			if (input === "list" || (!ctx.hasUI && !input)) {
				ctx.ui.notify(lines.join("\n"));
				return;
			}
			const remove = /^remove\s+(.+)$/.exec(input);
			let i: Instance | undefined;
			if (remove) i = values.find((i) => i.id === remove[1] || i.name.toLowerCase() === remove[1].toLowerCase());
			else if (!input) {
				const pick = await ctx.ui.select("Codex accounts", [...lines, "Add an account"]);
				if (!pick) return;
				if (pick === "Add an account") {
					await add(ctxUi(ctx));
					return;
				}
				i = values[lines.indexOf(pick)];
				const action = await ctx.ui.select(i.name, ["Rename", "Change base command", "Remove"]);
				if (!action) return;
				if (action === "Rename" || action === "Change base command") {
					const name = action === "Rename" ? "name" : "command";
					const value = (await ctx.ui.input(action, i[name]))?.trim();
					if (value) {
						if (name === "command") await withClient(value, ctx.cwd, listModels);
						save({ ...i, [name]: value });
					}
					return;
				}
				if (!(await ctx.ui.confirm("Remove " + i.name + "?", "Remove this provider from pi's model list?"))) return;
			}
			if (!i) {
				ctx.ui.notify("Usage: /codex-setup [list | add <name> = <command> | remove <name>]", "error");
				return;
			}
			saveInstances(configured().filter((a) => a.id !== i.id));
			sync();
			publishStatus();
			publishUsage();
		},
	});
	pi.registerCommand("codex-mode", {
		description: "Set the Codex permission mode",
		getArgumentCompletions: (p) => MODES.filter((m) => m.startsWith(p)).map((m) => ({ value: m, label: m })),
		handler: async (arg, ctx) => {
			const next = arg.trim() || (await ctx.ui.select("Codex mode", MODES));
			if (!next) return;
			if (!MODES.includes(next)) {
				ctx.ui.notify("Unknown mode. Choose " + MODES.join(", "), "error");
				return;
			}
			mode = next;
			publishStatus();
			ctx.ui.notify("Codex mode: " + mode);
		},
	});
	for (const what of ["models", "usage"])
		pi.registerCommand("codex-" + what, {
			description: "Refresh Codex " + what + " for each account",
			handler: async (_arg, ctx) => {
				const lines = await Promise.all(
					[...accounts.values()].map(async (a) => {
						try {
							await refresh(a, ctx.cwd);
						} catch (err) {
							return a.instance.name + ": " + errorText(err);
						}
						return what === "models"
							? selectable(a.models)
									.map((m) => a.instance.id + "/" + m.id)
									.join("\n")
							: a.instance.name +
									": " +
									(a.limits.map((w) => w.label + " " + w.percent + "%").join(" · ") || "No limits available");
					}),
				);
				ctx.ui.notify(lines.join("\n\n"));
			},
		});
	pi.registerCommand("codex-new", {
		description: "Start a fresh Codex thread with the pi transcript",
		handler: async (_arg, ctx) => {
			closeIdle();
			pi.appendEntry(RESET, {});
			views.clear();
			publishPanels();
			publishStatus();
			ctx.ui.notify("The next prompt starts a new Codex thread.");
		},
	});
	pi.registerCommand("codex-scratch", {
		description: "Show this session's Codex scratch directory",
		handler: async (_arg, ctx) => {
			ctx.ui.notify(scratchDir(session()));
		},
	});
}
