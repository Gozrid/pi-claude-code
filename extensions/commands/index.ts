/**
 * Common commands for pi, for every model:
 *
 *   /clear                               start a new session (like /new; the name Claude Code uses)
 *   /effort [low|medium|high|xhigh|max]  set the effort (pi's thinking level); without an argument
 *                                        as a slider with the levels the active model supports
 *   /export [copy|file [path]]           the whole conversation as Markdown, copied or saved
 *                                        (see export.ts; .html/.jsonl paths stay pi's export)
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickEffort } from "./effort-picker.ts";
import { exportCommand } from "./export.ts";

// Effort is pi's thinking level; for Claude CLI models it becomes `claude --effort`.
const EFFORT_HINTS: Record<string, string> = {
	off: "no thinking",
	minimal: "barely any thinking",
	low: "quick answers, least thinking",
	medium: "balanced",
	high: "deeper reasoning",
	xhigh: "extended reasoning",
	max: "maximum reasoning, slowest",
};

/** Levels the model accepts (Claude CLI models map off/minimal to nothing, so pi leaves them out). */
function effortLevels(model: ExtensionContext["model"]): string[] {
	return model ? (getSupportedThinkingLevels(model) as string[]) : Object.keys(EFFORT_HINTS);
}

export default function (pi: ExtensionAPI) {
	exportCommand(pi);

	/** Completions get no context; they offer the levels of the model last seen. */
	let model: ExtensionContext["model"];
	pi.on("session_start", async (_event, ctx) => {
		model = ctx.model;
	});
	pi.on("model_select", async (_event, ctx) => {
		model = ctx.model;
	});

	pi.registerCommand("clear", {
		description: "Start a new session (same as /new)",
		handler: async (_arg, ctx) => {
			await ctx.newSession({
				withSession: async (newCtx) => newCtx.ui.notify("New session started", "info"),
			});
		},
	});

	pi.registerCommand("effort", {
		description: "Set the effort level (thinking level): low, medium, high, xhigh, max",
		getArgumentCompletions: (prefix) => {
			const matches = effortLevels(model).filter((l) => l.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((l) => ({ value: l, label: l, description: EFFORT_HINTS[l] })) : null;
		},
		handler: async (arg, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("Select a model first (/model).", "error");
				return;
			}
			const levels = effortLevels(model);
			if (!model.reasoning || levels.length === 0) {
				ctx.ui.notify(`${model.name ?? model.id} has no effort levels.`, "warning");
				return;
			}
			const current = pi.getThinkingLevel();
			let level = arg?.trim().toLowerCase();
			if (!level) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Effort: ${current} (available: ${levels.join(", ")})`, "info");
					return;
				}
				const choice = await pickEffort(ctx, `Effort · ${model.name ?? model.id}`, levels, current, EFFORT_HINTS);
				if (!choice) return;
				level = choice;
			}
			if (!levels.includes(level)) {
				ctx.ui.notify(`"${level}" is not available for ${model.name ?? model.id}. Use one of: ${levels.join(", ")}`, "error");
				return;
			}
			pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
			ctx.ui.notify(`Effort: ${level}`, "info");
		},
	});
}
