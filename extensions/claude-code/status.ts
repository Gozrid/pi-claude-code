/**
 * What this extension publishes on the event channels of ../shared/agent-bus.ts:
 * the status of the selected Claude model (mode, model, effort, context, plan
 * usage) and the task list of the current session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentStatus, STATUS_CHANNEL, type StatusEvent, TASKS_CHANNEL, type TasksEvent } from "../shared/agent-bus.ts";
import { modelLabel } from "./cli.ts";
import { isClaudeProvider, runtime } from "./state.ts";
import { contextFor, sessionKey, tasksFor } from "./stream.ts";

/** Source name on the channels. */
export const SOURCE = "claude-code";

function statusData(ctx: ExtensionContext, effort: string | undefined): AgentStatus | undefined {
	const state = ctx.model ? runtime.instances.get(ctx.model.provider) : undefined;
	if (!ctx.model || !state) return undefined;
	// Claude Code's own count (updated with every API call of a run); pi's estimate only until there is one.
	const context = contextFor(sessionKey(ctx.model.provider, ctx.sessionManager.getSessionId()));
	const tokens = context?.tokens ?? ctx.getContextUsage()?.tokens ?? 0;
	const window = state.instance.contextWindow ?? context?.window ?? ctx.model.contextWindow;
	const { session, weekly } = state.usage ?? {};
	return {
		provider: ctx.model.provider,
		mode: runtime.permissionMode,
		model: modelLabel(state.models, ctx.model.id),
		instance: runtime.instances.size > 1 ? state.instance.name : undefined,
		// Models without effort levels (reasoning off) have nothing to show here.
		effort: ctx.model.reasoning && effort && effort !== "off" ? effort : undefined,
		context: window || tokens ? { tokens, window: window || undefined } : undefined,
		session: session && { percent: session.percent, resetsAt: session.resetsAt },
		weekly: weekly && { percent: weekly.percent },
	};
}

function tasksData(ctx: ExtensionContext) {
	const model = ctx.model;
	return model && isClaudeProvider(model.provider)
		? tasksFor(sessionKey(model.provider, ctx.sessionManager.getSessionId()))
		: [];
}

/**
 * Publishes the status and the task list of the given context, or of the last
 * one seen. `effort` reads the live thinking level; a context's own snapshot can be stale.
 */
export function createPublisher(events: ExtensionAPI["events"], effort: () => string | undefined) {
	let current: ExtensionContext | undefined;
	const publish = (ctx: ExtensionContext | undefined, send: (ctx: ExtensionContext) => void) => {
		if (!ctx?.hasUI) return;
		current = ctx;
		try {
			send(ctx);
		} catch {
			// The context went stale (reload or session switch); the next event brings a fresh one.
			current = undefined;
		}
	};
	return {
		status(ctx: ExtensionContext | undefined = current) {
			publish(ctx, (c) => events.emit(STATUS_CHANNEL, { source: SOURCE, status: statusData(c, effort()) } satisfies StatusEvent));
		},
		tasks(ctx: ExtensionContext | undefined = current) {
			publish(ctx, (c) => events.emit(TASKS_CHANNEL, { source: SOURCE, tasks: tasksData(c) } satisfies TasksEvent));
		},
		get context() {
			return current;
		},
		reset() {
			current = undefined;
		},
	};
}
