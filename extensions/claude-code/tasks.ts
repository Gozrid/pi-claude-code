/**
 * Claude's task list: follows the CLI's task tools (TaskCreate / TaskUpdate, or
 * the older TodoWrite). The task-list extension draws it above pi's editor.
 *
 * Print mode leaves the task tools off; CLAUDE_CODE_ENABLE_TODO_TOOLS=1 turns them on.
 */

import type { Task, TaskStatus } from "../shared/agent-bus.ts";

export const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

const isStatus = (value: unknown): value is TaskStatus =>
	value === "pending" || value === "in_progress" || value === "completed";

/**
 * The task list after one finished task tool call, or undefined when `name` is no
 * task tool. `result` is the call's structured result (`tool_use_result`).
 */
export function applyTaskTool(tasks: Task[], name: string, input: any, result: any): Task[] | undefined {
	switch (name) {
		case "TodoWrite": {
			if (!Array.isArray(input?.todos)) return tasks;
			return input.todos
				.filter((todo: any) => typeof todo?.content === "string")
				.map((todo: any, i: number) => ({
					id: String(i + 1),
					subject: todo.content,
					status: isStatus(todo.status) ? todo.status : "pending",
					activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
				}));
		}
		case "TaskCreate": {
			if (typeof input?.subject !== "string") return tasks;
			const highest = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0);
			const id = String(result?.task?.id ?? highest + 1);
			const task: Task = {
				id,
				subject: input.subject,
				status: "pending",
				activeForm: typeof input.activeForm === "string" ? input.activeForm : undefined,
			};
			return [...tasks.filter((t) => t.id !== id), task];
		}
		case "TaskUpdate": {
			const id = String(input?.taskId ?? "");
			if (input?.status === "deleted") return tasks.filter((t) => t.id !== id);
			return tasks.map((task) =>
				task.id !== id
					? task
					: {
							...task,
							status: isStatus(input.status) ? input.status : task.status,
							subject: typeof input.subject === "string" ? input.subject : task.subject,
							activeForm: typeof input.activeForm === "string" ? input.activeForm : task.activeForm,
						},
			);
		}
		default:
			return undefined;
	}
}
