/**
 * IDE for pi
 *
 * Connects pi to a JetBrains IDE (IntelliJ IDEA, WebStorm, Android Studio, …) or
 * VS Code through their Claude Code plugin, the way Claude Code itself connects
 * (see lockfiles.ts and connection.ts). Above the editor:
 *   ⧉ IntelliJ IDEA  src/foo.ts:12-30 · 19 lines · goes with your next message · alt+k insert
 * - the selection, or the open file, goes with the next message as context,
 *   once per selection (`/ide` switches that off)
 * - Alt+K inserts `@src/foo.ts#L12-30` into the editor; Cmd+Alt+K in the IDE
 *   ("Send to Claude Code") does the same from there
 * - a supported IDE running without the plugin, or with it switched off, gets a
 *   hint instead
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { IdeConnection } from "./connection.ts";
import { hintsFor, type IdeHint, integrationInstalled, listProcesses, parseProcesses, runningIdes } from "./detect.ts";
import { type IdeLock, pickLock, readLocks } from "./lockfiles.ts";
import {
	contextFor,
	type IdeSelection,
	insertion,
	lineCount,
	locationLabel,
	mentionFromParams,
	referenceFor,
	selectionFromParams,
	selectionKey,
} from "./reference.ts";

const WIDGET = "ide";
const MESSAGE = "ide-context";
const INSERT_KEY = "alt+k";
const POLL_MS = 3_000;
const HINT_POLL_MS = 30_000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(AGENT_DIR, "ide.json");

interface Settings {
	/** Send the selection (or the open file) with the next message. */
	attach: boolean;
	/** Hints hidden for good (IdeHint.id). */
	hiddenHints: string[];
}

function loadSettings(): Settings {
	try {
		const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		return {
			attach: data.attach !== false,
			hiddenHints: Array.isArray(data.hiddenHints) ? data.hiddenHints.filter((h: unknown) => typeof h === "string") : [],
		};
	} catch {
		return { attach: true, hiddenHints: [] };
	}
}

function saveSettings(settings: Settings): void {
	try {
		writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
	} catch {
		// Kept for this session only.
	}
}

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	let settings = loadSettings();
	let connection: IdeConnection | undefined;
	let connecting = false;
	let selection: IdeSelection | undefined;
	/** The selection (or open file) last sent with a message. */
	let sentKey: string | undefined;
	/** Lock files not to connect to on their own: another client took the IDE over, or the user disconnected. */
	const leftAlone = new Set<string>();
	/** Lock files that failed to connect, with when to try again. */
	const failed = new Map<string, number>();
	let hints: IdeHint[] = [];
	let lastHintCheck = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let renderQueued = false;

	const lockId = (lock: IdeLock) => `${lock.port}:${lock.authToken ?? ""}`;
	const cwd = () => current?.cwd ?? process.cwd();

	const widgetLine = (theme: ExtensionContext["ui"]["theme"]): string | undefined => {
		if (connection?.open) {
			const head = `${theme.fg("accent", "⧉")} ${theme.fg("muted", connection.ideName)}`;
			if (!selection) return `${head}  ${theme.fg("dim", "connected · select code to reference it")}`;
			const parts = [theme.fg("text", locationLabel(selection, cwd()))];
			const lines = lineCount(selection);
			if (lines > 0) parts.push(theme.fg("dim", `${lines} ${lines === 1 ? "line" : "lines"}`));
			if (settings.attach && selectionKey(selection) !== sentKey)
				parts.push(theme.fg("dim", lines > 0 ? "goes with your next message" : "named in your next message"));
			parts.push(theme.fg("dim", `${INSERT_KEY} insert`));
			return `${head}  ${parts.join(theme.fg("dim", " · "))}`;
		}
		const visible = hints.filter((h) => !settings.hiddenHints.includes(h.id));
		if (visible.length > 0) return `${theme.fg("warning", "⧉")} ${theme.fg("dim", `${visible[0].text} · /ide`)}`;
		return undefined;
	};

	const render = () => {
		renderQueued = false;
		const ctx = current;
		if (!ctx?.hasUI) return;
		try {
			const line = widgetLine(ctx.ui.theme);
			ctx.ui.setWidget(
				WIDGET,
				line === undefined
					? undefined
					: () => ({
							render: (width: number) => [truncateToWidth(widgetLine(ctx.ui.theme) ?? "", width)],
							invalidate() {},
						}),
			);
		} catch {
			// Stale context after a reload or session switch.
			current = undefined;
		}
	};

	/** Selections change with every caret move; draw once they settle. */
	const queueRender = () => {
		if (renderQueued) return;
		renderQueued = true;
		setTimeout(render, 30);
	};

	const insertReference = (sel: IdeSelection) => {
		const ctx = current;
		if (!ctx?.hasUI) return;
		ctx.ui.pasteToEditor(insertion(referenceFor(sel, ctx.cwd), ctx.ui.getEditorText()));
	};

	const connect = async (lock: IdeLock, byUser = false) => {
		if (connecting) return;
		connecting = true;
		connection?.close();
		connection = undefined;
		const id = lockId(lock);
		const conn: IdeConnection = new IdeConnection(lock, {
			notification(method, params) {
				if (connection !== conn) return;
				if (method === "selection_changed") {
					selection = selectionFromParams(params) ?? selection;
					queueRender();
				} else if (method === "at_mentioned") {
					const mention = mentionFromParams(params);
					if (mention) insertReference(mention);
				}
			},
			closed() {
				if (connection !== conn) return;
				connection = undefined;
				selection = undefined;
				// Still announced: someone else took the IDE over (it serves one client); do not fight over it.
				if (readLocks().some((l) => lockId(l) === id)) {
					leftAlone.add(id);
					current?.ui.notify(`${lock.ideName} disconnected pi (another Claude Code connected to it?) · /ide reconnects`, "info");
				}
				render();
			},
		});
		try {
			await conn.connect();
			connection = conn;
			selection = undefined;
			sentKey = undefined;
			failed.delete(id);
			leftAlone.delete(id);
			hints = [];
			if (byUser) current?.ui.notify(`Connected to ${lock.ideName}`, "info");
		} catch (error) {
			conn.close();
			failed.set(id, Date.now() + 30_000);
			if (byUser) current?.ui.notify((error as Error).message, "error");
		} finally {
			connecting = false;
			render();
		}
	};

	const checkHints = async () => {
		lastHintCheck = Date.now();
		const locks = readLocks();
		const running = runningIdes(parseProcesses(await listProcesses()));
		const lockPids = new Set(locks.map((l) => l.pid).filter((p): p is number => p !== undefined));
		hints = hintsFor(running, lockPids, (kind) => integrationInstalled(kind));
		render();
	};

	const poll = () => {
		if (!current?.hasUI || connection?.open || connecting) return;
		const now = Date.now();
		const locks = readLocks().filter((l) => !leftAlone.has(lockId(l)) && (failed.get(lockId(l)) ?? 0) <= now);
		const lock = pickLock(locks, cwd(), process.env.CLAUDE_CODE_SSE_PORT);
		if (lock) {
			void connect(lock);
			return;
		}
		if (now - lastHintCheck >= HINT_POLL_MS) void checkHints();
	};

	pi.registerShortcut(INSERT_KEY, {
		description: "Insert a reference to the IDE's selection or open file",
		handler: async (ctx) => {
			current = ctx;
			if (!connection?.open) {
				ctx.ui.notify("No IDE connected · /ide", "info");
				return;
			}
			if (!selection) {
				ctx.ui.notify(`Nothing open in ${connection.ideName}`, "info");
				return;
			}
			insertReference(selection);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !settings.attach || !connection?.open || !selection) return;
		const key = selectionKey(selection);
		if (key === sentKey) return;
		sentKey = key;
		queueRender();
		return {
			message: {
				customType: MESSAGE,
				content: contextFor(selection, ctx.cwd, connection.ideName),
				display: true,
				details: { ide: connection.ideName, label: locationLabel(selection, ctx.cwd), lines: lineCount(selection) },
			},
		};
	});

	pi.registerMessageRenderer(MESSAGE, (message, options, theme) => {
		const details = message.details as { ide?: string; label?: string; lines?: number } | undefined;
		const what = details?.lines ? `${details.label} (${details.lines} ${details.lines === 1 ? "line" : "lines"})` : `${details?.label} open`;
		let text = theme.fg("dim", `⧉ ${what} · ${details?.ide ?? "IDE"}`);
		if (options.expanded) text += `\n${theme.fg("dim", String(message.content))}`;
		return new Text(text, 0, 0);
	});

	pi.registerCommand("ide", {
		description: "IDE connection: connect, disconnect, send the selection with messages, hints",
		handler: async (_args, ctx) => {
			current = ctx;
			const locks = readLocks();
			if (!connection?.open) await checkHints();
			const options: Array<{ label: string; run(): void | Promise<void> }> = [];
			for (const lock of locks) {
				if (connection?.open && lockId(connection.lock) === lockId(lock)) continue;
				const folders = lock.workspaceFolders.map((f) => f.replace(homedir(), "~")).join(", ") || "no project";
				options.push({ label: `Connect to ${lock.ideName} (${folders})`, run: () => connect(lock, true) });
			}
			if (connection?.open) {
				const conn = connection;
				options.push({
					label: `Disconnect from ${conn.ideName}`,
					run: () => {
						leftAlone.add(lockId(conn.lock));
						connection = undefined;
						selection = undefined;
						conn.close();
						render();
					},
				});
			}
			options.push({
				label: settings.attach ? "Stop sending the selection with messages" : "Send the selection with messages",
				run: () => {
					settings = { ...settings, attach: !settings.attach };
					saveSettings(settings);
					render();
				},
			});
			for (const hint of hints.filter((h) => !settings.hiddenHints.includes(h.id))) {
				options.push({
					label: `Hide the hint about ${hint.ideName}`,
					run: () => {
						settings = { ...settings, hiddenHints: [...settings.hiddenHints, hint.id] };
						saveSettings(settings);
						render();
					},
				});
			}
			if (settings.hiddenHints.length > 0) {
				options.push({
					label: "Show hidden IDE hints again",
					run: () => {
						settings = { ...settings, hiddenHints: [] };
						saveSettings(settings);
						render();
					},
				});
			}
			const status = connection?.open
				? `Connected to ${connection.ideName}`
				: (hints[0]?.text ?? (locks.length > 0 ? "No IDE connected" : "No IDE with the Claude Code plugin found"));
			const choice = await ctx.ui.select(status, options.map((o) => o.label));
			await options.find((o) => o.label === choice)?.run();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		if (!ctx.hasUI) return;
		if (!timer) {
			timer = setInterval(poll, POLL_MS);
			timer.unref?.();
		}
		poll();
		render();
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		const conn = connection;
		connection = undefined;
		conn?.close();
		current = undefined;
	});
}
