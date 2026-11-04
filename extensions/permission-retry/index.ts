/**
 * Permission retry for pi
 *
 * A CLI agent in print mode cannot ask before an action its mode does not
 * allow; the action is denied and reported at the end of the run. Then this
 * asks how to allow it and sends a retry:
 *   Not allowed in mode auto: Bash npm test, Edit src/app.ts
 *   › Allow Bash, Edit once and retry
 *     Switch to accept edits and retry
 *     Not now
 * The denied actions and the ways to allow them come from the provider
 * extensions over pi's event bus (DENIALS_CHANNEL in ../shared/agent-bus.ts).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DENIALS_CHANNEL, type DenialsEvent } from "../shared/agent-bus.ts";
import { truncate } from "../shared/format.ts";

const NOT_NOW = "Not now";
const RETRY = "I allowed the actions that were not allowed before. Please retry them.";

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;

	const offer = async (event: DenialsEvent) => {
		const ctx = current;
		if (!ctx?.hasUI || ctx.model?.provider !== event.provider || event.items.length === 0) return;
		const what = event.items
			.map((item) => `${item.tool}${item.detail ? ` ${truncate(item.detail.replace(/\s+/g, " "), 60)}` : ""}`)
			.join(", ");
		try {
			const label = await ctx.ui.select(`Not allowed in mode ${event.mode}: ${what}`, [
				...event.choices.map((choice) => choice.label),
				NOT_NOW,
			]);
			const choice = event.choices.find((c) => c.label === label);
			if (!choice) return;
			choice.apply();
			pi.sendUserMessage(RETRY);
		} catch {
			// Stale context: nothing to offer any more.
		}
	};

	// Not awaited: the dialog must not hold up the end of the run.
	pi.events.on(DENIALS_CHANNEL, (data) => void offer(data as DenialsEvent));

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
	});
	pi.on("agent_start", async (_event, ctx) => {
		current = ctx;
	});
	pi.on("model_select", async (_event, ctx) => {
		current = ctx;
	});
	pi.on("session_shutdown", async () => {
		current = undefined;
	});
}
