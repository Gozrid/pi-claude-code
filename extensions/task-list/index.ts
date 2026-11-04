/**
 * Task list for pi
 *
 * Above the editor, the task list a CLI agent keeps with its own task tools
 * (Claude Code's TaskCreate / TaskUpdate / TodoWrite):
 *   Tasks 1/3 done
 *   ☒ Plan the change
 *   ◼ Writing the tests
 *   ☐ Update the README
 * It shows while the agent works on it and stays while tasks are open; a
 * finished list goes away after the run.
 *
 * The tasks come from the provider extensions over pi's event bus (TASKS_CHANNEL
 * in ../shared/agent-bus.ts).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Task, TASKS_CHANNEL, type TasksEvent } from "../shared/agent-bus.ts";
import { hasOpenTasks, renderTasks } from "./render.ts";

const WIDGET = "task-list";

export default function (pi: ExtensionAPI) {
	/** The latest list per provider extension; only the one with a model selected has tasks. */
	const lists = new Map<string, Task[]>();
	let running = false;
	let current: ExtensionContext | undefined;

	const render = (ctx: ExtensionContext | undefined = current) => {
		if (!ctx?.hasUI) return;
		current = ctx;
		const tasks = [...lists.values()].find((list) => list.length > 0) ?? [];
		const show = tasks.length > 0 && (running || hasOpenTasks(tasks));
		try {
			ctx.ui.setWidget(WIDGET, show ? renderTasks(ctx.ui.theme, tasks) : undefined);
		} catch {
			// Stale context after a reload or session switch.
			current = undefined;
		}
	};

	pi.events.on(TASKS_CHANNEL, (data) => {
		const event = data as TasksEvent;
		if (!event?.source) return;
		lists.set(event.source, event.tasks ?? []);
		render();
	});

	pi.on("session_start", async (_event, ctx) => {
		running = false;
		render(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		running = true;
		render(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		running = false;
		render(ctx);
	});
	pi.on("session_shutdown", async () => {
		current = undefined;
	});
}
