/**
 * Status line for the CLI providers (claude-code, antigravity)
 *
 * Below the editor, while a model of a CLI provider is selected:
 *   ⏵⏵ auto (shift+tab) │ Model: Opus 5.5 @ Work │ Effort: ●●○○○ medium │ Ctx: ░░░░░░░░░░ 2.2% 21.5k/1.00M │ …
 * In a narrow terminal the segments wrap onto further lines instead of being cut off.
 * Switching the mode types the new one in and lets a shine run across it.
 *
 * Shift+Tab switches the CLI's mode (auto → accept edits → plan for Claude
 * Code); for other models it cycles pi's thinking level as pi itself does.
 *
 * The data comes from the provider extensions over pi's event bus (see
 * ../shared/agent-bus.ts); without them, nothing is shown.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AgentStatus, MODE_CHANNEL, type ModeRequest, STATUS_CHANNEL, type StatusEvent } from "../shared/agent-bus.ts";
import { formatDuration, formatTokens } from "../shared/format.ts";

type Theme = ExtensionContext["ui"]["theme"];

const WIDGET = "agent-status-line";

/** Modes in the CLIs' own words: Claude Code (auto, acceptEdits, …) and Antigravity (default, accept-edits, …). */
const MODE_LABELS: Record<string, string> = {
	auto: "⏵⏵ auto",
	acceptEdits: "⏵⏵ accept edits",
	"accept-edits": "⏵⏵ accept edits",
	plan: "⏸ plan",
	default: "⏵ default",
	dontAsk: "dontAsk",
	bypassPermissions: "⚠ bypass permissions",
	bypass: "⚠ bypass permissions",
	manual: "manual",
};

const EFFORT_SCALE = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_COLORS: Record<string, string> = {
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** How long switching the mode plays; the first part types the new label in, the rest shines across it. */
export const MODE_ANIMATION_MS = 560;
const MODE_TYPING_SHARE = 0.55;
const MODE_TICK_MS = 40;

function modeColor(mode: string): Parameters<Theme["fg"]>[0] {
	return mode === "bypassPermissions" || mode === "bypass"
		? "error"
		: mode === "plan"
			? "syntaxType"
			: mode === "acceptEdits" || mode === "accept-edits"
				? "syntaxKeyword"
				: mode === "auto"
					? "success"
					: "muted";
}

/**
 * The mode with its shortcut hint. `elapsed` (ms since the mode was switched)
 * animates it: a block cursor types the label in, then a shine sweeps across.
 * The label keeps its full width throughout, so the segments after it stay put.
 */
export function modeSegment(theme: Theme, mode: string, elapsed = Number.POSITIVE_INFINITY): string {
	const label = MODE_LABELS[mode] ?? mode;
	const color = modeColor(mode);
	const hint = theme.fg("dim", " (shift+tab)");
	if (!(elapsed >= 0 && elapsed < MODE_ANIMATION_MS)) return `${theme.style(label, { fg: color, bold: true })}${hint}`;

	const chars = Array.from(label);
	const progress = elapsed / MODE_ANIMATION_MS;
	const plain = (text: string) => theme.style(text, { fg: color, bold: true });
	if (progress < MODE_TYPING_SHARE) {
		const typed = Math.min(chars.length, Math.floor((progress / MODE_TYPING_SHARE) * (chars.length + 1)));
		const cursor = typed < chars.length ? theme.style(chars[typed], { fg: color, bold: true, inverse: true }) : "";
		const rest = " ".repeat(Math.max(0, chars.length - typed - 1));
		return `${plain(chars.slice(0, typed).join(""))}${cursor}${rest}${hint}`;
	}
	// A three-cell shine moves from just before the label to just past it.
	const shine = 3;
	const sweep = (progress - MODE_TYPING_SHARE) / (1 - MODE_TYPING_SHARE);
	const start = Math.round(sweep * (chars.length + shine)) - shine;
	const before = chars.slice(0, Math.max(0, start)).join("");
	const lit = chars.slice(Math.max(0, start), Math.max(0, start + shine)).join("");
	const after = chars.slice(Math.max(0, start + shine)).join("");
	return `${plain(before)}${lit ? theme.style(lit, { fg: "text", bold: true }) : ""}${plain(after)}${hint}`;
}

/** "●●●○○ high" in the theme's colour for that thinking level. */
function effortSegment(theme: Theme, level: string): string {
	const rank = EFFORT_SCALE.indexOf(level) + 1;
	const dots = rank > 0 ? `${"●".repeat(rank)}${"○".repeat(EFFORT_SCALE.length - rank)} ` : "";
	const color = (EFFORT_COLORS[level] ?? "muted") as Parameters<Theme["fg"]>[0];
	return theme.style(`${dots}${level}`, { fg: color, bold: true });
}

/** The styled segments, in order; the mode leads so it stays on the first line. */
export function segments(theme: Theme, status: AgentStatus, now = Date.now(), modeElapsed?: number): string[] {
	const severity = (percent: number) => (percent < 50 ? "success" : percent < 80 ? "warning" : "error");
	const label = (text: string) => theme.fg("dim", `${text} `);
	// Each cell takes the colour of the range it stands for, so a fuller bar runs green → yellow → red.
	const coloredBar = (percent: number, width = 10) => {
		const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
		let out = "";
		for (let i = 0; i < width; i++) {
			out += i < filled ? theme.fg(severity(((i + 0.5) / width) * 100), "▓") : theme.fg("dim", "░");
		}
		return out;
	};
	const meter = (name: string, percent: number) =>
		`${label(name)}${coloredBar(percent)} ${theme.style(`${percent.toFixed(1)}%`, { fg: severity(percent), bold: true })}`;

	const instance = status.instance ? theme.fg("dim", ` @ ${status.instance}`) : "";
	const parts = [
		modeSegment(theme, status.mode, modeElapsed),
		`${label("Model:")}${theme.style(status.model, { fg: "accent", bold: true })}${instance}`,
	];
	if (status.effort) parts.push(`${label("Effort:")}${effortSegment(theme, status.effort)}`);
	const context = status.context;
	if (context?.window) {
		const percent = (context.tokens / context.window) * 100;
		parts.push(
			`${meter("Ctx:", percent)} ${theme.fg("dim", `${formatTokens(context.tokens)}/${formatTokens(context.window)}`)}`,
		);
	} else if (context?.tokens) {
		parts.push(`${label("Ctx:")}${theme.fg("syntaxNumber", formatTokens(context.tokens))}`);
	}
	if (status.session) parts.push(meter("Session:", status.session.percent));
	if (status.weekly) parts.push(meter("Weekly:", status.weekly.percent));
	if (status.session?.resetsAt) {
		parts.push(`${label("Reset:")}${theme.fg("syntaxType", "⟳ ")}${theme.fg("text", formatDuration(status.session.resetsAt - now))}`);
	}
	return parts;
}

/**
 * Packs the segments into as few lines as fit `width`, breaking only between
 * segments. A segment wider than a whole line is cut off.
 */
export function wrapSegments(parts: string[], separator: string, width: number): string[] {
	const gap = visibleWidth(separator);
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const part of parts) {
		const size = visibleWidth(part);
		if (line && used + gap + size <= width) {
			line += separator + part;
			used += gap + size;
			continue;
		}
		if (line) lines.push(line);
		line = size > width ? truncateToWidth(part, width) : part;
		used = Math.min(size, width);
	}
	if (line) lines.push(line);
	return lines;
}

export default function (pi: ExtensionAPI) {
	/** The latest status per provider extension; at most one has a model selected. */
	const statuses = new Map<string, AgentStatus>();
	let status: AgentStatus | undefined;
	let requestRender: (() => void) | undefined;
	/** When the mode last changed; the mode segment animates from there. */
	let modeSwitchedAt: number | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	/** Re-renders every frame until the switch animation has played. */
	const animateModeSwitch = () => {
		modeSwitchedAt = Date.now();
		stopTicker();
		ticker = setInterval(() => {
			if (modeSwitchedAt === undefined || Date.now() - modeSwitchedAt >= MODE_ANIMATION_MS) {
				modeSwitchedAt = undefined;
				stopTicker();
			}
			requestRender?.();
		}, MODE_TICK_MS);
		ticker.unref?.();
	};

	pi.events.on(STATUS_CHANNEL, (data) => {
		const event = data as StatusEvent;
		if (!event?.source) return;
		const previous = status;
		if (event.status) statuses.set(event.source, event.status);
		else statuses.delete(event.source);
		status = event.status ?? [...statuses.values()].at(-1);
		// The first status only shows the mode; a later, different one of the same provider is a switch.
		if (previous && status && previous.provider === status.provider && status.mode !== previous.mode) animateModeSwitch();
		requestRender?.();
	});

	// Shift+Tab is pi's thinking-level key by default; keybindings.json has to move
	// app.thinking.cycle elsewhere, otherwise pi skips this shortcut.
	pi.registerShortcut("shift+tab", {
		description: "Switch the CLI's mode (Claude Code: auto → accept edits → plan); other models: cycle thinking level",
		handler: async (ctx) => {
			const model = ctx.model;
			if (!model) return;
			if (status?.provider === model.provider) {
				pi.events.emit(MODE_CHANNEL, { provider: model.provider } satisfies ModeRequest);
				return;
			}
			const levels = getSupportedThinkingLevels(model);
			const current = levels.indexOf(pi.getThinkingLevel() as (typeof levels)[number]);
			pi.setThinkingLevel(levels[(current + 1) % levels.length]);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					render(width: number): string[] {
						if (!status) return [];
						const now = Date.now();
						const modeElapsed = modeSwitchedAt === undefined ? undefined : now - modeSwitchedAt;
						return wrapSegments(segments(theme, status, now, modeElapsed), theme.fg("borderMuted", " │ "), width);
					},
					invalidate() {},
					dispose() {
						requestRender = undefined;
						stopTicker();
					},
				};
			},
			{ placement: "belowEditor" },
		);
	});
}
