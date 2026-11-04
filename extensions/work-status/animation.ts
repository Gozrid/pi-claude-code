/**
 * Working animation for the CLI providers, in Claude Code's style: a breathing
 * spinner, a shimmering verb (or the running tool's), the elapsed time and the
 * tokens so far, in the provider's colours (see ../shared/brand.ts). What the
 * CLI does comes over ACTIVITY_CHANNEL.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Activity } from "../shared/agent-bus.ts";
import { brandFor, pick, type Rgb } from "../shared/brand.ts";
import { formatElapsed, formatTokens, truncate } from "../shared/format.ts";

const TOOL_VERBS: Record<string, string> = {
	Bash: "Running",
	Read: "Reading",
	Write: "Writing",
	Edit: "Editing",
	MultiEdit: "Editing",
	NotebookEdit: "Editing",
	Grep: "Searching",
	Glob: "Searching",
	WebFetch: "Fetching",
	WebSearch: "Browsing",
	Task: "Delegating",
	Agent: "Delegating",
	TodoWrite: "Planning",
};

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return {
		r: Math.round(a.r + (b.r - a.r) * t),
		g: Math.round(a.g + (b.g - a.g) * t),
		b: Math.round(a.b + (b.b - a.b) * t),
	};
}

function rgb(c: Rgb) {
	return { kind: "rgb" as const, ...c };
}

/** `activity` reads what the CLI does right now. */
export function createAnimation(activity: () => Activity | undefined) {
	let running: { timer: ReturnType<typeof setInterval>; ctx: ExtensionContext } | undefined;

	const stop = () => {
		if (!running) return;
		clearInterval(running.timer);
		const { ctx } = running;
		running = undefined;
		try {
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
		} catch {
			// The UI context is gone after a reload or session switch.
		}
	};

	const start = (ctx: ExtensionContext) => {
		if (running || !ctx.hasUI || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const startedAt = Date.now();
		const brand = brandFor(ctx.model);
		const verb = pick(brand.verbs);

		// The spinner breathes from the deep colour to its light and back (Claude: orange to peach).
		ctx.ui.setWorkingIndicator({
			frames: brand.frames.map((frame, i) =>
				theme.style(frame, {
					fg: rgb(mix(brand.accent, brand.light, Math.sin((i / brand.frames.length) * Math.PI) * 0.6)),
					bold: true,
				}),
			),
			intervalMs: 110,
		});

		let tick = 0;
		const render = () => {
			const a = activity();
			const word =
				a?.phase === "tool" ? (TOOL_VERBS[a.tool ?? ""] ?? `Using ${a.tool}`) : a?.phase === "writing" ? "Writing" : verb;
			const text = `${word}…`;
			// A highlight sweeps across the word, then pauses off-screen before the next pass.
			const sweep = (tick * 0.5) % (text.length + 12);
			let shimmer = "";
			for (let i = 0; i < text.length; i++) {
				const glow = Math.max(0, 1 - Math.abs(i - sweep) / 2.5);
				shimmer += theme.style(text[i], { fg: rgb(mix(brand.accent, brand.light, glow)), bold: true });
			}

			const meta = [formatElapsed(Date.now() - startedAt)];
			if (a && a.tokens > 0) meta.push(`↓ ${formatTokens(a.tokens)} tokens`);
			if (a?.phase === "thinking") meta.push("thinking");
			if (a?.phase === "tool" && a.detail) meta.push(truncate(a.detail.replace(/\s+/g, " "), 48));
			meta.push("esc to interrupt");
			try {
				ctx.ui.setWorkingMessage(`${shimmer} ${theme.fg("dim", `(${meta.join(" · ")})`)}`);
			} catch {
				stop();
			}
			tick++;
		};
		render();
		const timer = setInterval(render, 80);
		timer.unref?.();
		running = { timer, ctx };
	};

	return {
		start,
		stop,
		get running() {
			return running !== undefined;
		},
	};
}
