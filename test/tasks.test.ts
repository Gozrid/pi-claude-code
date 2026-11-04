import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTaskTool } from "../extensions/claude-code/tasks.ts";
import type { Task } from "../extensions/shared/agent-bus.ts";
import { hasOpenTasks } from "../extensions/task-list/render.ts";

test("TaskCreate adds a pending task with the id from the result", () => {
	const tasks = applyTaskTool([], "TaskCreate", { subject: "Write intro", activeForm: "Writing intro" }, { task: { id: "7" } });
	assert.deepEqual(tasks, [{ id: "7", subject: "Write intro", status: "pending", activeForm: "Writing intro" }]);
});

test("TaskCreate without a result numbers on from the highest id", () => {
	const tasks = applyTaskTool([{ id: "2", subject: "a", status: "pending" }], "TaskCreate", { subject: "b" }, undefined);
	assert.equal(tasks?.[1].id, "3");
});

test("TaskUpdate changes status and text, deleted removes the task", () => {
	const start: Task[] = [
		{ id: "1", subject: "a", status: "pending" },
		{ id: "2", subject: "b", status: "pending" },
	];
	const updated = applyTaskTool(start, "TaskUpdate", { taskId: "1", status: "in_progress", subject: "A" }, undefined)!;
	assert.deepEqual(updated[0], { id: "1", subject: "A", status: "in_progress", activeForm: undefined });
	assert.deepEqual(applyTaskTool(updated, "TaskUpdate", { taskId: "2", status: "deleted" }, undefined)?.map((t) => t.id), ["1"]);
});

test("TodoWrite replaces the whole list", () => {
	const tasks = applyTaskTool([{ id: "9", subject: "old", status: "pending" }], "TodoWrite", {
		todos: [
			{ content: "first", status: "completed", activeForm: "Doing first" },
			{ content: "second", status: "bogus" },
		],
	}, undefined);
	assert.deepEqual(tasks, [
		{ id: "1", subject: "first", status: "completed", activeForm: "Doing first" },
		{ id: "2", subject: "second", status: "pending", activeForm: undefined },
	]);
});

test("other tools leave the list alone", () => {
	assert.equal(applyTaskTool([], "Bash", { command: "ls" }, undefined), undefined);
});

test("hasOpenTasks", () => {
	assert.equal(hasOpenTasks([{ id: "1", subject: "a", status: "completed" }]), false);
	assert.equal(hasOpenTasks([{ id: "1", subject: "a", status: "in_progress" }]), true);
});
