/**
 * pi bridge for pi
 *
 * An MCP server inside pi for the CLI agents pi starts (Claude Code, agy):
 * questions to the user in a dialog (`ask`), permission requests answered in
 * pi while the agent waits (Claude's --permission-prompt-tool `permission`,
 * agy's PreToolUse hook, see agy-gate.ts), a
 * hand-off for wishes to change pi (`change_request`), pi's state and settings
 * to read, and settings, theme, model, keys and MCP servers to change after
 * asking the user.
 *
 * The provider extensions ask for the server over BRIDGE_CHANNEL
 * (../shared/agent-bus.ts) before they start their CLI. pi's own models get the
 * same tools as pi tools (`pi_ask`, `pi_change_request` directly, the rest
 * through tool search).
 *
 * pi's MCP servers reach the CLIs through pi's own connections (mcp-proxy.ts),
 * so they do not start them a second time.
 *
 * While the chat is empty, the open wishes of the wish list (wishes.ts) stand
 * at the bottom right: offered to provider-logo over WISH_LIST_CHANNEL, else
 * right-aligned above the editor. A click on them, or `/wishes`, opens the
 * wish popup (wish-popup.ts) to read and manage the whole list.
 *
 * Watches (watch.ts) are commands pi runs while an agent waits on something
 * outside; they stand above the editor while they run, `/watches` stops them,
 * and when one ends its result goes to the agent in a message that starts a turn.
 *
 * Steps (steps.ts) are a stepper an agent shows above the editor for a job of
 * several steps and moves on as it works; `/steps` hides it.
 */

import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Markdown, type OverlayOptions, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { BRIDGE_CHANNEL, type BridgeRequest } from "../shared/agent-bus.ts";
import { BridgeServer } from "./server.ts";
import { McpProxy } from "./mcp-proxy.ts";
import { PI_MCP_SOURCE } from "../shared/pi-mcp.ts";
import { GATE_RULES, GATED_MODES, HOOK_TIMEOUT } from "./agy-gate.ts";
import { agyHook, bridgeTools, type ClientData, type Host, SERVER_INSTRUCTIONS, wishesFileOf } from "./tools.ts";
import { readWishes, setWishStatus, wishLineIds, wishLines } from "./wishes.ts";
import { WishBrowser, workPrompt } from "./wish-popup.ts";
import { endHeadline, endMessage, formatElapsed, watchLines, Watches, type WatchEnd } from "./watch.ts";
import { SPINNER_MS, Stepper, stepLines } from "./steps.ts";
import { darkenBackdrop } from "../shared/backdrop.ts";
import { OPENING_MS, UNFOLD_MS, unfoldedSize } from "../shared/opening.ts";
import { rowClick, WISH_LIST_CHANNEL, type WishListOffer } from "../shared/wish-list.ts";

export const SERVER_NAME = "pi";
export const PERMISSION_TOOL = `mcp__${SERVER_NAME}__permission`;
/** pi tools the model sees right away; the others are found through tool search. */
const DIRECT = new Set(["ask", "change_request"]);
const WISH_WIDGET = "pi-bridge-wishes";
const WATCH_WIDGET = "pi-bridge-watches";
const WATCH_MESSAGE = "pi-watch";
const STEPS_WIDGET = "pi-bridge-steps";
const POPUP_LAYOUT = { width: "90%", minWidth: 40, maxHeight: "90%", anchor: "center" } satisfies OverlayOptions;
/** Frames of the opening animation. */
const FRAME_MS = 33;

/** Opens a file in the system's app for it (the default text editor for Markdown on macOS). */
function openInEditor(file: string, onError: (message: string) => void): void {
	const [command, args] = process.platform === "darwin" ? ["open", ["-t", file]] : ["xdg-open", [file]];
	try {
		const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
		child.on("error", (error) => onError(error.message));
		child.unref();
	} catch (error) {
		onError(error instanceof Error ? error.message : String(error));
	}
}


function chatIsEmpty(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	const host: Host = { pi, ctx: () => current, sessionRules: new Set() };
	const tools = bridgeTools(host);

	/** The open wish popup. */
	let popup: WishBrowser | undefined;
	const openPopup = (ctx: ExtensionContext, selected?: number) => {
		if (ctx.mode !== "tui" || popup) return;
		const file = wishesFileOf(host);
		const markdownTheme = getMarkdownTheme();
		const reload = () => popup?.reload();
		let closed = false;
		let restoreBackdrop: (() => void) | undefined;
		let frames: ReturnType<typeof setInterval> | undefined;
		// Starts small; the opening unfolds it (pi reads this object on every render).
		const layout: OverlayOptions = { ...POPUP_LAYOUT, width: 12, minWidth: undefined };
		const stop = () => {
			if (closed) return;
			closed = true;
			unwatchFile(file, reload);
			if (frames) clearInterval(frames);
			restoreBackdrop?.();
			popup = undefined;
		};
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const close = () => {
					stop();
					done();
				};
				const browser = new WishBrowser({
					theme,
					load: () => readWishes(file),
					markdown: (text, width) => new Markdown(text, 0, 0, markdownTheme).render(width),
					rows: () => Math.floor(tui.terminal.rows * 0.9),
					requestRender: () => tui.requestRender(),
					selected,
					setStatus: (id, status) => {
						setWishStatus(file, id, status);
						host.wishesChanged?.();
					},
					work: (wish) => {
						close();
						ctx.ui.setEditorText(workPrompt(wish));
					},
					edit: () => openInEditor(file, (message) => ctx.ui.notify(`Could not open ${file}: ${message}`, "warning")),
					copy: (wish) =>
						void copyToClipboard(`#${wish.id} ${wish.title}\n\n${wish.description}`).then(
							() => ctx.ui.notify(`Wish #${wish.id} copied`, "info"),
							() => ctx.ui.notify("Copying failed", "warning"),
						),
					close,
				});
				popup = browser;
				// Opens like /usage: the frame unfolds from the middle while the chat behind it
				// darkens, then the title is typed and the rows appear; the frames are rendered here.
				const openedAt = Date.now();
				restoreBackdrop = darkenBackdrop(tui, theme, UNFOLD_MS);
				frames = setInterval(() => {
					tui.requestRender();
					if (Date.now() - openedAt >= OPENING_MS && frames) {
						clearInterval(frames);
						frames = undefined;
					}
				}, FRAME_MS);
				frames.unref?.();
				const render = (width: number) => {
					const elapsed = Date.now() - openedAt;
					if (elapsed < UNFOLD_MS) {
						const fullWidth = Math.max(POPUP_LAYOUT.minWidth, Math.floor(tui.terminal.columns * 0.9));
						const size = unfoldedSize(elapsed, fullWidth, browser.height());
						// Takes effect with the next frame.
						layout.width = size.width;
						layout.minWidth = undefined;
						return browser.renderUnfolding(width, size.rows);
					}
					Object.assign(layout, POPUP_LAYOUT);
					return browser.render(width, elapsed < OPENING_MS ? elapsed : undefined);
				};
				// Edits by hand (e) and by other pi sessions show up while the popup is open.
				watchFile(file, { interval: 1000 }, reload);
				return {
					render,
					invalidate: () => browser.invalidate(),
					handleInput: (data: string) => browser.handleInput(data),
					handleMouse: (event: TuiMouseEvent) => browser.handleMouse(event),
					dispose: stop,
				};
			},
			{ overlay: true, overlayOptions: layout },
		);
	};

	/** Whether the wish list is shown (the chat is empty). */
	let wishesShown = false;
	const showWishes = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const wishes = readWishes(wishesFileOf(host));
		const lines = wishLines(ctx.ui.theme, wishes);
		const ids = wishLineIds(wishes);
		const open = (row: number) => openPopup(current ?? ctx, ids[row]);
		let taken = false;
		pi.events.emit(WISH_LIST_CHANNEL, { lines, take: () => (taken = true), open } satisfies WishListOffer);
		wishesShown = lines.length > 0;
		if (taken || lines.length === 0) ctx.ui.setWidget(WISH_WIDGET, undefined);
		else
			ctx.ui.setWidget(WISH_WIDGET, () => {
				let width = 0;
				return {
					// Right-aligned, one column in from the edge like pi's other widgets.
					render: (w: number) => {
						width = w;
						return lines.map((line) => `${" ".repeat(Math.max(0, w - visibleWidth(line) - 1))}${line}`);
					},
					handleMouse: (event: TuiMouseEvent) => rowClick(event, lines, 0, width, open),
					invalidate() {},
				};
			});
	};
	const hideWishes = (ctx: ExtensionContext) => {
		if (!wishesShown) return;
		wishesShown = false;
		pi.events.emit(WISH_LIST_CHANNEL, { lines: [], take: () => {} } satisfies WishListOffer);
		try {
			ctx.ui.setWidget(WISH_WIDGET, undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};
	host.wishesChanged = () => {
		popup?.reload();
		if (current?.mode === "tui" && chatIsEmpty(current)) showWishes(current);
	};
	// Watches: shown above the editor while they run; their end starts a turn with the result.
	const stoppedByUser = new Set<number>();
	let watchTicker: ReturnType<typeof setInterval> | undefined;
	const showWatches = () => {
		const ctx = current;
		const running = host.watches?.list() ?? [];
		if (running.length === 0 && watchTicker) {
			clearInterval(watchTicker);
			watchTicker = undefined;
		}
		if (running.length > 0 && !watchTicker) {
			watchTicker = setInterval(showWatches, 1000);
			watchTicker.unref?.();
		}
		if (ctx?.mode !== "tui") return;
		try {
			ctx.ui.setWidget(WATCH_WIDGET, running.length ? watchLines(ctx.ui.theme, running, Date.now()) : undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};
	host.watches = new Watches({
		onChange: showWatches,
		onEnd: (end: WatchEnd) => {
			const byUser = stoppedByUser.delete(end.watch.id);
			const content = byUser ? `${endMessage(end)}\nThe user stopped it.` : endMessage(end);
			pi.sendMessage(
				{
					customType: WATCH_MESSAGE,
					content,
					display: true,
					details: { id: end.watch.id, description: end.watch.description, reason: end.reason, exitCode: end.exitCode, durationMs: end.durationMs, tail: end.tail },
				},
				// A watch the user stopped waits for their next message; every other end starts a turn.
				byUser ? { deliverAs: "nextTurn" } : { triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
	pi.registerMessageRenderer(WATCH_MESSAGE, (message, options, theme) => {
		const details = message.details as { id: number; description: string; reason: WatchEnd["reason"]; exitCode: number | null; durationMs: number; tail: string } | undefined;
		if (!details) return new Text(String(message.content), 0, 0);
		let out = endHeadline(theme, details);
		if (options.expanded && details.tail) out += `\n${theme.fg("dim", details.tail)}`;
		else if (details.tail) out += theme.fg("dim", ` (${options.keyHint("app.tools.expand", "output")})`);
		return new Text(out, 0, 0);
	});
	pi.registerCommand("watches", {
		description: "List the watches pi runs while an agent waits on something outside, and stop one",
		handler: async (_arg, ctx) => {
			const running = host.watches?.list() ?? [];
			if (running.length === 0) {
				ctx.ui.notify("No watches running", "info");
				return;
			}
			const now = Date.now();
			const labels = running.map((w) => `#${w.id} ${w.description} · ${formatElapsed(now - w.startedAt)} · ${w.command}`);
			const choice = await ctx.ui.select("Stop a watch", labels);
			const watch = choice === undefined ? undefined : running[labels.indexOf(choice)];
			if (!watch) return;
			stoppedByUser.add(watch.id);
			if (!host.watches?.stop(watch.id)) stoppedByUser.delete(watch.id);
		},
	});

	// Steps: a stepper above the editor; the running step's spinner and time tick on.
	let stepsShown = false;
	let refreshSteps: (() => void) | undefined;
	const showSteps = () => {
		const ctx = current;
		const list = host.steps?.list;
		if (ctx?.mode !== "tui") return;
		if (Boolean(list) === stepsShown) {
			refreshSteps?.();
			return;
		}
		stepsShown = Boolean(list);
		try {
			if (!list) {
				refreshSteps = undefined;
				ctx.ui.setWidget(STEPS_WIDGET, undefined);
				return;
			}
			ctx.ui.setWidget(STEPS_WIDGET, (tui, theme) => {
				let frame = 0;
				let ticker: ReturnType<typeof setInterval> | undefined;
				const tick = () => {
					const running = host.steps?.list?.steps.some((s) => s.status === "running") ?? false;
					if (running && !ticker) {
						ticker = setInterval(() => {
							frame++;
							tui.requestRender();
						}, SPINNER_MS);
						ticker.unref?.();
					} else if (!running && ticker) {
						clearInterval(ticker);
						ticker = undefined;
					}
				};
				refreshSteps = () => {
					tick();
					tui.requestRender();
				};
				tick();
				return {
					render: (width: number) => {
						const shown = host.steps?.list;
						return shown ? stepLines(theme, shown, width, Date.now(), frame) : [];
					},
					invalidate() {},
					dispose: () => {
						if (ticker) clearInterval(ticker);
					},
				};
			});
		} catch {
			// Stale context after a reload or session switch.
			stepsShown = false;
			refreshSteps = undefined;
		}
	};
	host.steps = new Stepper({ onChange: showSteps });
	pi.registerCommand("steps", {
		description: "Hide the steps an agent shows above the editor",
		handler: async (_arg, ctx) => {
			if (!host.steps?.clear()) ctx.ui.notify("No steps shown", "info");
		},
	});

	const server = new BridgeServer(() => tools, { name: SERVER_NAME, version: "1.0.0" }, SERVER_INSTRUCTIONS);
	server.hook = (payload, client) => agyHook(host, payload, client);
	const proxy = new McpProxy(
		() => pi.getAllTools(),
		// pi connects mcp.json's servers only with its own MCP support on (not with --no-mcp or another MCP extension).
		() => pi.getCommands().some((c) => c.name === "mcp" && c.sourceInfo?.path === PI_MCP_SOURCE),
	);
	server.proxy = (name) => proxy.server(name);

	pi.events.on(BRIDGE_CHANNEL, (data) => {
		const request = data as BridgeRequest;
		const url = server.url;
		if (!url) return;
		const token = server.token({
			provider: request.provider,
			kind: request.kind,
			data: {
				cwd: request.cwd,
				claudeSettings: request.claudeSettings,
				agySettings: request.agySettings,
				mode: request.mode,
			} satisfies ClientData,
		});
		const headers = { Authorization: `Bearer ${token}` };
		// Every agy run gets the hook: it holds agy while a dialog waits for the user, in every mode.
		// Only the gated modes also ask before actions, with the broad allow rules that needs.
		const hooked = request.kind === "agy" && current?.hasUI;
		const gated = GATED_MODES.includes(request.mode ?? "default");
		request.reply({
			name: SERVER_NAME,
			url,
			headers,
			...(proxy.active ? { mcpUrl: url } : {}),
			...(request.kind === "claude" && current?.hasUI ? { permissionTool: PERMISSION_TOOL } : {}),
			...(hooked
				? {
						gate: {
							url: server.hookUrl!,
							headers,
							// agy would deny pi's own tools in print mode; they ask the user themselves where it matters.
							allow: gated ? [...GATE_RULES, ...tools.filter((t) => !t.only).map((t) => `mcp(${SERVER_NAME}/${t.name})`)] : [],
							timeout: HOOK_TIMEOUT,
						},
					}
				: {}),
		});
	});

	for (const tool of tools) {
		if (tool.only) continue;
		pi.registerTool({
			name: `pi_${tool.name}`,
			label: `pi ${tool.name.replace(/_/g, " ")}`,
			description: tool.description,
			parameters: Type.Unsafe<Record<string, any>>(tool.inputSchema),
			exposure: DIRECT.has(tool.name) ? "direct" : "deferred",
			annotations: tool.annotations,
			// pi lends its tools here whenever they change; the MCP proxy needs them.
			...(tool.name === "ask" ? { prepareLoadout: (loadout: Parameters<typeof proxy.update>[0]) => void proxy.update(loadout) } : {}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const result = await tool.call(params ?? {}, {
					provider: ctx.model?.provider ?? "",
					kind: "pi",
					data: { cwd: ctx.cwd } satisfies ClientData,
				});
				if (result.isError) throw new Error(result.text);
				return { content: [{ type: "text", text: result.text }], details: undefined };
			},
		});
	}

	const track = async (_event: unknown, ctx: ExtensionContext) => {
		current = ctx;
	};
	pi.registerCommand("wishes", {
		description: "Open pi's wish list: every wish to read in full, filter, search and work on",
		handler: async (arg, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The wish list needs the interactive terminal UI; the file is " + wishesFileOf(host), "warning");
				return;
			}
			const id = Number(arg?.trim().replace(/^#/, ""));
			openPopup(ctx, Number.isInteger(id) && id > 0 ? id : undefined);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		stepsShown = false;
		refreshSteps = undefined;
		host.steps?.clear();
		if (ctx.mode === "tui" && chatIsEmpty(ctx)) showWishes(ctx);
		else hideWishes(ctx);
		try {
			await server.start();
		} catch (error) {
			ctx.ui.notify(`pi bridge: could not start its MCP server: ${error instanceof Error ? error.message : error}`, "warning");
		}
	});
	pi.on("agent_start", async (_event, ctx) => {
		current = ctx;
		hideWishes(ctx);
	});
	pi.on("message_start", async (_event, ctx) => hideWishes(ctx));
	pi.on("model_select", track);
	pi.on("session_shutdown", async (_event, ctx) => {
		hideWishes(ctx);
		host.steps?.clear();
		current = undefined;
		host.watches?.stopAll();
		proxy.clear();
		await server.stop();
	});
}
