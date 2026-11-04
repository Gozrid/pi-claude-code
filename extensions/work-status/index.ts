/**
 * Work status for pi, for every model:
 *
 * - after each answer a line "✻ Cooked for 1m 12s · ↓ 3.4k tokens" in the chat
 *   (for Antigravity "◝ Floated for 1m 12s"; see ../shared/brand.ts)
 *   (a custom entry: shown, saved with the session, never sent to the model)
 * - while a CLI provider (claude-code, antigravity) works, an animation in Claude
 *   Code's style above the editor: breathing star, shimmering verb, time, tokens
 * - the terminal tab title shows a spinning star while pi works and ✓ when an
 *   answer finished while the window was in the background
 * - a macOS notification when an answer took a while and the window was not in focus
 * - a session title after the first answer, written by the smallest model of the
 *   selected provider (haiku for Claude, a mini/flash/nano model elsewhere): it
 *   names the session (as /name does) and so the terminal tab. Sessions with a
 *   name of their own keep it.
 *
 * Usage:
 *   /retitle          write a new title for the session now
 *
 * Environment:
 *   PI_NOTIFY_AFTER   seconds an answer must take before it notifies (default 30, "off" disables)
 *   PI_AUTO_TITLE=0   no automatic session titles
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type Activity,
	ACTIVITY_CHANNEL,
	type ActivityEvent,
	ONESHOT_CHANNEL,
	type OneShotRequest,
} from "../shared/agent-bus.ts";
import { brandFor, pick } from "../shared/brand.ts";
import { formatElapsed, formatTokens } from "../shared/format.ts";
import { createAnimation } from "./animation.ts";
import { cleanTitle, smallestModel, TITLE_SYSTEM_PROMPT, titlePrompt } from "./title.ts";

const ENTRY_TYPE = "work-status";
const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

interface WorkEntry {
	ms: number;
	tokens: number;
	outcome: "completed" | "aborted" | "error";
	verb: string;
	/** The provider's mark (see ../shared/brand.ts); entries written before it had one get ✻. */
	mark?: string;
}

const AUTO_TITLE = process.env.PI_AUTO_TITLE !== "0";
/** Tries per session before the automatic title gives up. */
const TITLE_ATTEMPTS = 2;
const TITLE_TIMEOUT_MS = 60_000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join(" ");
}

/** The first prompt of the session and the start of what came back. */
function firstExchange(ctx: ExtensionContext): { prompt: string; answer: string } | undefined {
	const messages = ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: any }).message);
	const prompt = messages.find((m) => m?.role === "user");
	const answer = messages.find((m) => m?.role === "assistant" && textOf(m.content).trim());
	if (!prompt || !answer) return undefined;
	return { prompt: textOf(prompt.content), answer: textOf(answer.content) };
}

/**
 * A title from the selected provider's smallest model. CLI providers answer it
 * themselves over ONESHOT_CHANNEL (their CLI, without tools or a saved session);
 * other providers through pi's model registry.
 */
async function writeTitle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	const exchange = firstExchange(ctx);
	const model = ctx.model;
	if (!exchange || !model) return undefined;
	const prompt = titlePrompt(exchange.prompt, exchange.answer);
	let claimed = false;
	const answer = new Promise<string | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), TITLE_TIMEOUT_MS);
		timer.unref?.();
		const request: OneShotRequest = {
			provider: model.provider,
			system: TITLE_SYSTEM_PROMPT,
			prompt,
			claim: () => {
				claimed = true;
			},
			reply: (text) => {
				clearTimeout(timer);
				resolve(text);
			},
		};
		pi.events.emit(ONESHOT_CHANNEL, request);
		if (!claimed) {
			clearTimeout(timer);
			resolve(undefined);
		}
	});
	if (claimed) return cleanTitle(await answer);
	const small = smallestModel(ctx.modelRegistry.getAvailable(), model.provider) ?? model;
	const response = await ctx.modelRegistry.complete(
		small,
		{ systemPrompt: TITLE_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ signal: AbortSignal.timeout(TITLE_TIMEOUT_MS), maxTokens: 40 },
	);
	return cleanTitle(textOf(response.content));
}

const notifyAfterMs = (() => {
	const raw = process.env.PI_NOTIFY_AFTER;
	if (raw === "off") return Number.POSITIVE_INFINITY;
	const seconds = Number(raw);
	return (Number.isFinite(seconds) && raw ? seconds : 30) * 1000;
})();

/** An AppleScript string literal. */
const appleString = (text: string) => `"${text.replace(/[\r\n]+/g, " ").replace(/[\\"]/g, "\\$&")}"`;

function notify(title: string, message: string): void {
	if (process.platform !== "darwin") return;
	const script = `display notification ${appleString(message)} with title ${appleString(title)} sound name "Glass"`;
	execFile("osascript", ["-e", script], () => {});
}

/** Text of the last assistant message, for the notification. */
function lastAnswer(messages: any[]): string {
	const last = [...messages].reverse().find((m) => m?.role === "assistant");
	const content = last?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join(" ");
}

export default function (pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let titleTimer: ReturnType<typeof setInterval> | undefined;
	/** Whether the terminal window has focus; undefined until the terminal reports it. */
	let focused: boolean | undefined;
	let unread = false;
	let current: ExtensionContext | undefined;
	let stopFocus: (() => void) | undefined;

	/** What the CLI of the selected provider does in this run. */
	let activity: Activity | undefined;
	const animation = createAnimation(() => activity);
	pi.events.on(ACTIVITY_CHANNEL, (data) => {
		const event = data as ActivityEvent;
		const ctx = current;
		if (!event || !ctx || startedAt === undefined || ctx.model?.provider !== event.provider) return;
		activity = event.activity;
		if (activity && !animation.running) animation.start(ctx);
	});

	/** pi's own title: "π - <session> - <folder>". */
	const baseTitle = (ctx: ExtensionContext) => {
		const name = pi.getSessionName();
		return ["π", name, basename(ctx.cwd)].filter(Boolean).join(" - ");
	};

	const setTitle = (ctx: ExtensionContext | undefined, title: string) => {
		try {
			ctx?.ui.setTitle(title);
		} catch {
			// Stale context after a reload or session switch.
		}
	};

	const stopTitle = () => {
		if (titleTimer) clearInterval(titleTimer);
		titleTimer = undefined;
	};

	/** Sessions whose title is being written or was tried, with the number of tries. */
	const titleTries = new Map<string, number>();
	let titling = false;

	/** Writes a title and names the session with it; `force` replaces a name it already has. */
	const retitle = async (ctx: ExtensionContext, force = false): Promise<string | undefined> => {
		const session = ctx.sessionManager.getSessionId();
		if (titling || (!force && pi.getSessionName())) return undefined;
		titling = true;
		titleTries.set(session, (titleTries.get(session) ?? 0) + 1);
		try {
			const title = await writeTitle(pi, ctx);
			// The session may have been named by hand or switched in the meantime.
			if (!title || ctx.sessionManager.getSessionId() !== session || (!force && pi.getSessionName())) return undefined;
			pi.setSessionName(title);
			if (!titleTimer && ctx.mode === "tui") setTitle(ctx, `${unread ? "✓ " : ""}${baseTitle(ctx)}`);
			return title;
		} catch {
			return undefined;
		} finally {
			titling = false;
		}
	};

	pi.registerCommand("retitle", {
		description: "Write a new title for this session with the provider's smallest model (/name sets one by hand)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Writing a title…", "info");
			const title = await retitle(ctx, true);
			ctx.ui.notify(title ? `Session title: ${title}` : "No title came back", title ? "info" : "warning");
		},
	});

	pi.registerEntryRenderer<WorkEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const time = formatElapsed(data.ms);
		const text =
			data.outcome === "aborted"
				? `Interrupted after ${time}`
				: data.outcome === "error"
					? `Failed after ${time}`
					: `${data.verb} for ${time}`;
		const tokens = data.tokens > 0 ? ` · ↓ ${formatTokens(data.tokens)} tokens` : "";
		return new Text(`${theme.fg("accent", data.mark ?? "✻")} ${theme.fg("dim", `${text}${tokens}`)}`, 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		if (ctx.mode !== "tui" || stopFocus) return;
		// Focus reports tell whether a notification is needed; terminals without them never send any.
		process.stdout.write(FOCUS_ON);
		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!data.includes(FOCUS_IN) && !data.includes(FOCUS_OUT)) return undefined;
			focused = data.lastIndexOf(FOCUS_IN) > data.lastIndexOf(FOCUS_OUT);
			if (focused && unread) {
				unread = false;
				if (!titleTimer && current) setTitle(current, baseTitle(current));
			}
			const rest = data.split(FOCUS_IN).join("").split(FOCUS_OUT).join("");
			return rest ? { data: rest } : { consume: true };
		});
		stopFocus = () => {
			unsubscribe();
			process.stdout.write(FOCUS_OFF);
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		current = ctx;
		startedAt = Date.now();
		unread = false;
		if (ctx.mode !== "tui") return;
		stopTitle();
		const base = baseTitle(ctx);
		// The spinner without its first frame, which is a dot for Claude's star.
		const frames = brandFor(ctx.model).frames.filter((f) => f !== "·");
		let frame = 0;
		const tick = () => setTitle(ctx, `${frames[frame++ % frames.length]} ${base}`);
		tick();
		titleTimer = setInterval(tick, 400);
		titleTimer.unref?.();
	});

	pi.on("agent_end", async (event, ctx) => {
		animation.stop();
		activity = undefined;
		stopTitle();
		const ms = startedAt === undefined ? 0 : Date.now() - startedAt;
		startedAt = undefined;
		const messages = event.messages as any[];
		const assistants = messages.filter((m) => m?.role === "assistant");
		const tokens = assistants.reduce((sum, m) => sum + (m.usage?.output ?? 0), 0);
		const stop = assistants.at(-1)?.stopReason;
		const outcome = stop === "aborted" ? "aborted" : stop === "error" ? "error" : "completed";

		if (ms >= 1000) {
			const brand = brandFor(ctx.model);
			pi.appendEntry<WorkEntry>(ENTRY_TYPE, { ms, tokens, outcome, verb: pick(brand.doneVerbs), mark: brand.mark });
		}

		// Not awaited: the title is written in the background.
		const tries = titleTries.get(ctx.sessionManager.getSessionId()) ?? 0;
		if (AUTO_TITLE && outcome === "completed" && tries < TITLE_ATTEMPTS && !pi.getSessionName()) void retitle(ctx);

		if (ctx.mode !== "tui") return;
		const inBackground = focused === false;
		unread = inBackground;
		setTitle(ctx, `${inBackground ? "✓ " : ""}${baseTitle(ctx)}`);
		// Without focus reports, a long answer notifies anyway: better one too many than none.
		if (ms >= notifyAfterMs && focused !== true && outcome !== "aborted") {
			const answer = lastAnswer(messages).replace(/\s+/g, " ").trim();
			const title = `pi · ${basename(ctx.cwd)}`;
			const head = outcome === "error" ? `Failed after ${formatElapsed(ms)}` : `Done after ${formatElapsed(ms)}`;
			notify(title, answer ? `${head}: ${answer.slice(0, 120)}` : head);
			process.stdout.write("\x07");
		}
	});

	pi.on("session_shutdown", async () => {
		animation.stop();
		activity = undefined;
		stopTitle();
		stopFocus?.();
		stopFocus = undefined;
		current = undefined;
	});
}
