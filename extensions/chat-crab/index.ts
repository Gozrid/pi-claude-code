/**
 * Chat crab for pi
 *
 * Once a chat with a Claude model has started, a tiny Clawd lives above the
 * editor (for an Antigravity model Gravi, a small hover bot, see crab.ts) and
 * acts out what the agent is doing: a sent message folds into an
 * envelope in the editor (see send.ts) and the crab catches it as it flies up;
 * it ponders with a thought bubble while the model thinks, patters while it
 * writes and plays the running tool: reads a book, types the file name it
 * edits or the command into a terminal, spins a globe for the web, sends a
 * buddy crab off for a subagent, ticks a checklist for todos, and walks to and
 * fro with the name of any other tool. It winces when a tool fails, cheers when
 * the answer is done (or a commit, push or test run went through), gets droopy
 * eyes on long runs and falls asleep when idle, sooner at night. In the empty
 * chat, provider-logo shows the big Clawd instead.
 *
 * Tools of pi's own come from its tool events; the Claude Code CLI runs its tools
 * itself, so for it they come from the provider extension over pi's event bus (TOOL_CHANNEL).
 * The crab stays at its spot while it acts something out; only a long stretch of
 * thinking sends it to another one. While the agent works, chat-view's key
 * hints (steer, queue, stop) stand right-aligned on the crab's middle row; the
 * crab and its scenes keep left of them.
 *
 * Usage:
 *   /crab [on|off]   show or hide the crab (toggles without an argument)
 *
 * PI_CRAB=0 starts with the crab hidden.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HINTS_HOST_CHANNEL, QUEUE_HINTS_CHANNEL, type QueueHints } from "../chat-view/queue.ts";
import { TOOL_CHANNEL, type ToolEvent } from "../shared/agent-bus.ts";
import {
	crabFrame,
	DURATION,
	FLIGHT_START,
	FOLD_MS,
	type Mascot,
	type Mood,
	type PropRow,
	type Scene,
	SIDE_ROOM,
	STEP_MS,
	toolMood,
	WIDTH,
} from "./crab.ts";
import { FoldEditor } from "./send.ts";
import { brandFor } from "../shared/brand.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Rgb = { r: number; g: number; b: number };

const WIDGET = "chat-crab";

/** How often the animation checks for a new frame. */
const TICK_MS = 60;
/** Idle this long, the crab falls asleep; at night sooner. */
const SLEEP_AFTER_MS = 90_000;
const SLEEP_AFTER_NIGHT_MS = 20_000;
/** A run this long makes the crab tired. */
const TIRED_AFTER_MS = 180_000;
/** Thinking this long without a new scene, the crab moves on to another spot. */
const WANDER_MS = 20_000;

/** Pixel colours per mascot: Clawd's orange; Gravi's Google blue with a yellow and red thruster flame. */
const PALETTES: Record<Mascot, Record<string, Rgb>> = {
	clawd: {
		o: { r: 0xd9, g: 0x77, b: 0x57 },
		l: { r: 0x8f, g: 0x4a, b: 0x33 },
	},
	gravi: {
		o: { r: 0x42, g: 0x85, b: 0xf4 },
		l: { r: 0x1a, g: 0x56, b: 0xc4 },
		h: { r: 0xfb, g: 0xbc, b: 0x05 },
		f: { r: 0xea, g: 0x43, b: 0x35 },
	},
};

/** Tool lines claude-code writes into the answer; their tools arrive on TOOL_CHANNEL instead. */
const CLI_TOOL_LINE = /^(⏺|⎿|✗)/;

/** Commands worth a cheer when they succeed. */
const CHEERS: [RegExp, string][] = [
	[/\bgit\s+commit\b/, "committed"],
	[/\bgit\s+push\b/, "pushed"],
	[/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|vitest|jest)\b|\b(cargo|go|dotnet)\s+test\b/, "passed"],
];

/** The selected model's mascot: Clawd for Claude, Gravi for Antigravity, none for others. */
const mascotFor = (model: ExtensionContext["model"]): Mascot | undefined => brandFor(model).mascot;

function chatIsEmpty(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

function isNight(): boolean {
	const hour = new Date().getHours();
	return hour >= 22 || hour < 6;
}

/** What a tool works on, from its arguments: a command, a path, a URL, a query. */
function detailOf(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	const pick = a.command ?? a.file_path ?? a.path ?? a.notebook_path ?? a.url ?? a.query ?? a.pattern ?? a.description;
	return typeof pick === "string" ? pick : undefined;
}

/** Pixel rows as half blocks: one column and half a row per pixel, so pixels stay square. */
function drawArt(theme: Theme, art: string[], colors: Record<string, Rgb>): string[] {
	const lines: string[] = [];
	for (let r = 0; r < art.length; r += 2) {
		let line = "";
		for (let c = 0; c < art[r].length; c++) {
			const top = colors[art[r][c]];
			const bottom = colors[art[r + 1]?.[c] ?? "."];
			if (!top && !bottom) line += " ";
			else if (top === bottom) line += theme.style("█", { fg: { kind: "rgb", ...top } });
			else if (!bottom) line += theme.style("▀", { fg: { kind: "rgb", ...top } });
			else if (!top) line += theme.style("▄", { fg: { kind: "rgb", ...bottom } });
			else line += theme.style("▀", { fg: { kind: "rgb", ...top }, bg: { kind: "rgb", ...bottom } });
		}
		lines.push(line);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_CRAB !== "0";
	/** Whether the chat has a first message. */
	let started = false;
	let shown = false;
	/** Whether the agent is working, and since when. */
	let running = false;
	let runStart = 0;

	let mood: Mood = "idle";
	/** When the current mood began. */
	let since = Date.now();
	/** What the agent is doing; the crab returns to it after a one-off mood. */
	let activity: Mood = "thinking";
	let tool: string | undefined;
	let detail: string | undefined;
	let cheer: string | undefined;

	let x = 0;
	let direction: -1 | 1 = 1;
	let lastStep = 0;
	/** Where the crab is heading between scenes; it walks there before it acts out the next one. */
	let target = 0;
	let lastWander = 0;
	let lastWidth = 80;
	/** chat-view's key hints, shown right-aligned on the crab's middle row while the agent works. */
	let hints: QueueHints | undefined;
	let requestRender: (() => void) | undefined;
	pi.events.on(QUEUE_HINTS_CHANNEL, (data) => {
		const next = data as QueueHints | undefined;
		if (next?.line === hints?.line) return;
		hints = next;
		requestRender?.();
	});

	let ticker: ReturnType<typeof setInterval> | undefined;

	/** Starts `next`; `skip` ms of a one-off mood are left out. */
	const setMood = (next: Mood, skip = 0) => {
		if (next === mood && DURATION[next] === undefined) return;
		mood = next;
		since = Date.now() - skip;
	};

	/** The mood now, after one-off moods ran out and idling turned into sleep. */
	const current = (now: number): { mood: Mood; time: number } => {
		const duration = DURATION[mood];
		if (duration !== undefined && now - since >= duration) {
			mood = running ? activity : "idle";
			since += duration;
		}
		const time = now - since;
		const sleepAfter = isNight() ? SLEEP_AFTER_NIGHT_MS : SLEEP_AFTER_MS;
		if (mood === "idle" && time >= sleepAfter) return { mood: "sleep", time: time - sleepAfter };
		return { mood, time };
	};

	/** Who acts, from the selected model; set when the crab is shown. */
	let mascot: Mascot = "clawd";

	const scene = (now: number): Scene => ({
		mascot,
		direction,
		tool,
		detail,
		cheer,
		tired: running && now - runStart > TIRED_AFTER_MS,
		room: room(),
	});

	/** Sets what the agent is doing; a one-off mood that still plays finishes first. */
	const setActivity = (next: Mood, toolName?: string, toolDetail?: string) => {
		// A new scene plays right where the crab is; a walk on the way is called off.
		if (next !== activity || toolName !== tool) {
			target = x;
			lastWander = Date.now();
		}
		activity = next;
		tool = toolName;
		detail = toolDetail;
		if (DURATION[current(Date.now()).mood] === undefined) setMood(next);
	};

	const toolStarted = (name: string, toolDetail?: string) => setActivity(toolMood(name), name, toolDetail);

	/** After a tool: wince on errors, cheer on commits, pushes and passing tests. */
	const toolEnded = (isError: boolean) => {
		const command = activity === "terminal" ? detail : undefined;
		setActivity("thinking");
		const win = command && CHEERS.find(([pattern]) => pattern.test(command))?.[1];
		if (isError) setMood("ouch");
		else if (win) {
			cheer = win;
			setMood("cheer");
		}
	};

	/** Columns for the crab and its scenes: all but the key hints and a gap before them. */
	const avail = () => (hints ? Math.max(WIDTH + 13, lastWidth - hints.width - 2) : lastWidth);
	/** Room beside the crab; a narrow terminal keeps a third of its width for the crab to walk in. */
	const room = () => Math.max(12, Math.min(SIDE_ROOM, Math.floor(((avail() - WIDTH - 1) * 2) / 3)));
	const maxX = () => Math.max(0, avail() - WIDTH - 1 - room());

	/** Picks a new spot to walk to, at least a few columns away when there is room. */
	const wander = (now: number) => {
		lastWander = now;
		const max = maxX();
		if (max === 0) return;
		let next = Math.floor(Math.random() * (max + 1));
		if (Math.abs(next - x) < Math.min(6, max / 2)) next = x < max / 2 ? Math.min(max, x + 6 + (next % 6)) : Math.max(0, x - 6 - (next % 6));
		target = next;
	};

	/** On its way to `target`: walks, unless a one-off mood plays or it sleeps. */
	const heading = (m: Mood) => x !== target && running && DURATION[m] === undefined && m !== "walking";

	const step = (now: number) => {
		if (now - lastStep < STEP_MS) return;
		const { mood: m } = current(now);
		if (m === "walking") {
			lastStep = now;
			if (x + direction < 0 || x + direction > maxX()) direction = direction < 0 ? 1 : -1;
			x = Math.min(maxX(), Math.max(0, x + direction));
			target = x;
		} else if (heading(m)) {
			lastStep = now;
			direction = target > x ? 1 : -1;
			x += direction;
		} else if (running && m === "thinking" && now - lastWander > WANDER_MS) {
			// A long stretch of thinking: move on to another spot now and then.
			wander(now);
		}
	};

	/** The frame to draw: walking while on the way to the next spot, else the mood's own. */
	const frameAt = (now: number) => {
		const { mood: m, time } = current(now);
		const walking = heading(m);
		const shown: Mood = walking ? "walking" : m;
		const frame = crabFrame(shown, walking ? now - lastWander : time, { ...scene(now), tool: walking ? undefined : tool });
		return { mood: shown, frame };
	};

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	const show = (ctx: ExtensionContext) => {
		shown = true;
		// The hints move onto the crab's rows from now on.
		pi.events.emit(HINTS_HOST_CHANNEL, true);
		ctx.ui.setWidget(WIDGET, (tui, theme) => {
			requestRender = () => tui.requestRender();
			let last = "";
			stopTicker();
			ticker = setInterval(() => {
				const now = Date.now();
				step(now);
				const { frame } = frameAt(now);
				const key = `${x}|${JSON.stringify(frame)}`;
				if (key === last) return;
				last = key;
				tui.requestRender();
			}, TICK_MS);
			ticker.unref?.();

			const paint = (row: PropRow): string =>
				truncateToWidth(
					row
						.map(({ text, color }) =>
							color === "clawd" ? theme.style(text, { fg: { kind: "rgb", ...PALETTES[mascot].o } }) : theme.fg(color ?? "muted", text),
						)
						.join(""),
					room(),
				);

			/** What is beside the crab, one string per row. */
			const side = (frame: ReturnType<typeof crabFrame>): string[] => {
				if (frame.prop) return frame.prop.map(paint);
				if (frame.buddy) {
					const pad = " ".repeat(frame.buddy.x);
					return [frame.buddy.caption ? paint(frame.buddy.caption) : "", ...drawArt(theme, frame.buddy.art, PALETTES[mascot]).map((row) => pad + row)];
				}
				return [];
			};

			return {
				render(width: number): string[] {
					lastWidth = width;
					const right = (line: string, from: number) => {
						const used = visibleWidth(line);
						return hints ? `${line}${" ".repeat(Math.max(1, from - used))}${hints.line}` : line;
					};
					if (width < WIDTH + 2) return hints ? [truncateToWidth(right("", width - hints.width), width)] : [];
					x = Math.min(x, maxX());
					target = Math.min(target, maxX());
					const now = Date.now();
					const { frame } = frameAt(now);
					const pad = " ".repeat(x);
					const beside = side(frame);
					const hintsAt = hints ? Math.max(0, width - hints.width) : width;
					return drawArt(theme, frame.art, PALETTES[mascot]).map((line, i) => {
						const left = truncateToWidth(`${pad}${line}${beside[i] ?? ""}`, Math.min(width, avail()));
						return truncateToWidth(i === 1 ? right(left, hintsAt) : left, width);
					});
				},
				invalidate() {},
				dispose() {
					stopTicker();
				},
			};
		});
	};

	const hide = (ctx: ExtensionContext) => {
		if (!shown) return;
		shown = false;
		requestRender = undefined;
		stopTicker();
		// The steer and queue panel draws its own hints row again.
		pi.events.emit(HINTS_HOST_CHANNEL, false);
		hints = undefined;
		try {
			ctx.ui.setWidget(WIDGET, undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};

	const update = (ctx: ExtensionContext) => {
		const wanted = enabled && started && ctx.mode === "tui" && mascotFor(ctx.model) !== undefined;
		mascot = mascotFor(ctx.model) ?? mascot;
		if (wanted && !shown) show(ctx);
		else if (!wanted) hide(ctx);
	};

	/** A message is caught; without the fold in the editor first, its envelope takes off at once. */
	const catchMessage = (folded = false) => {
		if (current(Date.now()).mood !== "catch") setMood("catch", folded ? 0 : FOLD_MS);
	};

	pi.on("session_start", async (_event, ctx) => {
		started = !chatIsEmpty(ctx);
		running = false;
		setMood("idle");
		update(ctx);
		if (ctx.mode !== "tui") return;
		// The editor folds a sent message up below where the crab's envelope takes off.
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new FoldEditor(tui, theme, keybindings, () => {
					if (!shown) return undefined;
					catchMessage(true);
					return x + WIDTH + FLIGHT_START;
				}),
		);
	});

	pi.on("model_select", async (_event, ctx) => update(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		started = true;
		running = true;
		runStart = Date.now();
		activity = "thinking";
		tool = detail = undefined;
		update(ctx);
		catchMessage();
	});

	// A message steered or queued while the agent works is caught too; the scene goes on after.
	pi.on("input", async (event) => {
		if (running && event.streamingBehavior) catchMessage();
	});

	pi.on("message_update", async (event) => {
		const e = event.assistantMessageEvent;
		if (e.type === "thinking_start" || e.type === "thinking_delta") {
			if (activity !== "thinking") setActivity("thinking");
		} else if (e.type === "text_delta") {
			if (!CLI_TOOL_LINE.test(e.delta) && activity !== "writing") setActivity("writing");
		}
	});

	pi.events.on(TOOL_CHANNEL, (data) => {
		const event = data as ToolEvent;
		if (event.type === "start") toolStarted(event.name, event.detail);
		else toolEnded(event.isError);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) toolStarted(event.toolName, detailOf(event.args));
	});

	pi.on("tool_execution_end", async (event) => {
		if (!event.parentToolCallId) toolEnded(event.isError);
	});

	pi.on("agent_settled", async (event) => {
		running = false;
		tool = detail = cheer = undefined;
		setMood(event.aborted ? "idle" : "cheer");
	});

	pi.on("session_shutdown", async (_event, ctx) => hide(ctx));

	pi.registerCommand("crab", {
		description: "Show or hide the chat crab: /crab [on|off]",
		getArgumentCompletions: (prefix: string) =>
			["on", "off"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
		handler: async (arg, ctx) => {
			const value = arg.trim().toLowerCase();
			enabled = value === "on" ? true : value === "off" ? false : !enabled;
			update(ctx);
			if (!enabled) ctx.ui.notify("Crab hidden", "info");
			else if (!mascotFor(ctx.model)) ctx.ui.notify("Crab on – it shows with Claude and Antigravity models", "info");
			else if (!started) ctx.ui.notify("Crab on – it shows once the chat has started", "info");
		},
	});
}
