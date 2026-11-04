/**
 * Steer and queue (part of chat-view)
 *
 * While the agent works, a panel above the editor shows the keys for talking to
 * it in between — steer (arrives after the current step), steer now (stops the
 * current step and sends right away), queue (arrives once it is done), edit what
 * is waiting, stop — right-aligned, and lists the messages that wait, each
 * marked as steering or queued. While chat-crab shows its crab, the keys go onto
 * the crab's middle row in short form (HINTS_HOST_CHANNEL, QUEUE_HINTS_CHANNEL). pi's own "Steering: …" / "Follow-up: …" lines
 * are hidden while the panel shows them.
 *
 * The keys are pi's (tui.input.submit, app.message.followUp, app.message.dequeue,
 * app.interrupt), so changes in keybindings.json show up here; steer now is this
 * extension's ctrl+enter.
 *
 * Usage:
 *   /queue [on|off]   show the panel or pi's own lines (toggles without an argument)
 *   ctrl+enter        steer now: stop the current step and send the editor text
 *   /now <message>    the same, for terminals that cannot tell ctrl+enter from enter
 *
 * PI_QUEUE_VIEW=0 starts with it off.
 */

import { type ExtensionAPI, type ExtensionContext, keyText } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	HINTS_HOST_CHANNEL,
	hintsLine,
	MessageQueue,
	QUEUE_HINTS_CHANNEL,
	type QueueHints,
	type QueueKeys,
	queueLines,
} from "./queue.ts";

const WIDGET = "message-queue";
const STEER_NOW_KEY = "ctrl+enter";
/** How long steer now waits for the stopped step to wind down. */
const STOP_TIMEOUT_MS = 10_000;

function keys(): QueueKeys {
	return {
		steer: keyText("tui.input.submit") || "enter",
		now: STEER_NOW_KEY,
		queue: keyText("app.message.followUp") || "alt+enter",
		edit: keyText("app.message.dequeue") || "alt+up",
		stop: keyText("app.interrupt") || "escape",
	};
}

/** pi's container for waiting messages: the one holding its "Steering: …" / "Follow-up: …" lines. */
function findPiQueue(tui: TUI): Component | undefined {
	const stack: unknown[] = [...tui.children];
	while (stack.length > 0) {
		const node = stack.pop() as { children?: unknown[]; entries?: { component: unknown }[] } | undefined;
		const children = Array.isArray(node?.children) ? node.children : [];
		const lines = children.filter((c) => (c as object)?.constructor?.name.startsWith("TruncatedText"));
		if (lines.some((c) => /(Steering|Follow-up): /.test(String((c as { text?: unknown }).text)))) return node as Component;
		stack.push(...children);
		if (Array.isArray(node?.entries)) stack.push(...node.entries.map((e) => e.component));
	}
	return undefined;
}

export function messageQueue(pi: ExtensionAPI) {
	let enabled = process.env.PI_QUEUE_VIEW !== "0";
	const queue = new MessageQueue();
	let ctx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	/** pi's container, once found; its render is wrapped to stay empty while the panel shows. */
	let piQueue: Component | undefined;
	/** Whether chat-crab shows the key hints beside the crab, on the same rows. */
	let crabHosts = false;
	let published: string | undefined;
	pi.events.on(HINTS_HOST_CHANNEL, (hosts) => {
		crabHosts = hosts === true;
		requestRender?.();
	});

	/** Hands chat-crab the hints to show; undefined takes them away. Only when they change. */
	const publishHints = (hints: QueueHints | undefined) => {
		if (hints?.line === published) return;
		published = hints?.line;
		pi.events.emit(QUEUE_HINTS_CHANNEL, hints);
	};

	/** Stops the current step, waits for the agent to wind down, then sends `text` as a new prompt. */
	const steerNow = async (context: ExtensionContext, text: string) => {
		if (context.isIdle()) {
			pi.sendUserMessage(text);
			return;
		}
		context.abort();
		const until = Date.now() + STOP_TIMEOUT_MS;
		while (!context.isIdle() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
		pi.sendUserMessage(text, context.isIdle() ? undefined : { deliverAs: "steer" });
	};

	const working = () => {
		try {
			return !!ctx && !ctx.isIdle();
		} catch {
			// Stale context after a reload or session switch.
			return false;
		}
	};

	/** Messages pi no longer holds (sent, restored to the editor, dropped on abort) leave the panel. */
	const sync = () => {
		try {
			if (ctx && !ctx.hasPendingMessages()) queue.settle();
		} catch {
			// Stale context.
		}
	};

	const hidePiQueue = (tui: TUI) => {
		if (piQueue) return;
		const found = findPiQueue(tui);
		if (!found) return;
		piQueue = found;
		const original = found.render.bind(found);
		found.render = (width: number) => (enabled && queue.messages.length > 0 ? [] : original(width));
		tui.requestRender();
	};

	const show = (context: ExtensionContext) => {
		if (context.mode !== "tui") return;
		context.ui.setWidget(WIDGET, (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				render(width: number): string[] {
					if (!working()) {
						publishHints(undefined);
						return [];
					}
					sync();
					if (queue.messages.length > 0) hidePiQueue(tui);
					const { lines } = queueLines(theme, queue.messages, keys(), width, !crabHosts);
					if (crabHosts) {
						const line = hintsLine(theme, keys(), queue.messages.length > 0, true);
						publishHints({ line, width: visibleWidth(line) });
					} else publishHints(undefined);
					return lines;
				},
				invalidate() {},
				dispose() {
					requestRender = undefined;
				},
			};
		});
	};

	const hide = (context: ExtensionContext) => {
		publishHints(undefined);
		try {
			context.ui.setWidget(WIDGET, undefined);
		} catch {
			// Stale context.
		}
	};

	const refresh = (context: ExtensionContext) => {
		ctx = context;
		requestRender?.();
	};

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		queue.clear();
		if (enabled) show(context);
	});

	pi.on("input", async (event, context) => {
		if (event.streamingBehavior) queue.add(event.streamingBehavior, event.text);
		refresh(context);
		return { action: "continue" };
	});

	pi.on("message_start", async (event, context) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role === "user") {
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
						: "";
			queue.delivered(text);
		}
		refresh(context);
	});

	pi.on("agent_start", async (_event, context) => refresh(context));
	pi.on("agent_settled", async (_event, context) => {
		queue.clear();
		refresh(context);
	});

	pi.registerShortcut(STEER_NOW_KEY, {
		description: "Steer now: stop the current step and send the editor text right away",
		handler: async (context) => {
			const text = context.ui.getEditorText().trim();
			if (!text) return;
			context.ui.setEditorText("");
			await steerNow(context, text);
		},
	});

	pi.registerCommand("now", {
		description: "Steer now: stop the current step and send this message right away: /now <message>",
		handler: async (args, context) => {
			const text = args.trim();
			if (!text) {
				context.ui.notify("Usage: /now <message>", "warning");
				return;
			}
			await steerNow(context, text);
		},
	});

	pi.registerCommand("queue", {
		description: "Show steering and queued messages with their keys above the editor: /queue [on|off]",
		handler: async (args, context) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			ctx = context;
			if (enabled) show(context);
			else hide(context);
			context.ui.notify(`Steer and queue panel ${enabled ? "on" : "off"}`, "info");
		},
	});
}
