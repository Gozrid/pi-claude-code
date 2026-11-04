/**
 * The task list as Claude Code shows it: ◼ running, ☐ open, ☒ done.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Task } from "../shared/agent-bus.ts";

type Theme = ExtensionContext["ui"]["theme"];

export const hasOpenTasks = (tasks: Task[]) => tasks.some((task) => task.status !== "completed");

export function renderTasks(theme: Theme, tasks: Task[]): string[] {
	const done = tasks.filter((task) => task.status === "completed").length;
	const lines = [`${theme.fg("muted", "Tasks")} ${theme.fg("dim", `${done}/${tasks.length} done`)}`];
	for (const task of tasks) {
		if (task.status === "in_progress") {
			lines.push(`${theme.fg("accent", "◼")} ${theme.bold(theme.fg("accent", task.activeForm ?? task.subject))}`);
		} else if (task.status === "completed") {
			lines.push(theme.fg("dim", `☒ ${theme.strikethrough(task.subject)}`));
		} else {
			lines.push(`${theme.fg("muted", "☐")} ${task.subject}`);
		}
	}
	return lines;
}
