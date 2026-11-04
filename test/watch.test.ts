/**
 * pi-bridge: watches, the commands pi runs while an agent waits on something outside.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridgeTools, type Host } from "../extensions/pi-bridge/tools.ts";
import {
	endHeadline,
	endMessage,
	formatElapsed,
	tailOf,
	timeoutMsOf,
	type WatchEnd,
	watchLines,
	Watches,
} from "../extensions/pi-bridge/watch.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-watch-test-")));

/** A Watches whose ends are awaited one by one. */
function watches() {
	const ends: WatchEnd[] = [];
	const waiting: ((end: WatchEnd) => void)[] = [];
	let changes = 0;
	const list = new Watches({
		onEnd: (end) => {
			const next = waiting.shift();
			if (next) next(end);
			else ends.push(end);
		},
		onChange: () => changes++,
	});
	const nextEnd = () => (ends.length ? Promise.resolve(ends.shift()!) : new Promise<WatchEnd>((r) => waiting.push(r)));
	return { list, nextEnd, changes: () => changes };
}

test("a watch reports its exit code and the end of its output when its command ends", async () => {
	const { list, nextEnd, changes } = watches();
	const watch = list.start({ command: "echo one; echo two >&2; pwd; exit 3", description: "CI", cwd: work, timeoutMs: 10_000 });
	assert.deepEqual(list.list().map((w) => w.id), [watch.id]);
	const end = await nextEnd();
	assert.equal(end.reason, "exited");
	assert.equal(end.exitCode, 3);
	assert.match(end.tail, /one/);
	assert.match(end.tail, /two/);
	assert.match(end.tail, new RegExp(work));
	assert.deepEqual(list.list(), []);
	assert.equal(changes(), 2);

	const message = endMessage(end);
	assert.match(message, /^Watch #\d+ "CI" failed with exit code 3 after \d+s\./);
	assert.match(message, /Command: echo one/);
	assert.match(message, /Last output:\n```\n/);
});

test("a successful watch says so, and one without output says that", async () => {
	const { list, nextEnd } = watches();
	list.start({ command: "true", description: "deploy", cwd: work, timeoutMs: 10_000 });
	const end = await nextEnd();
	assert.equal(end.exitCode, 0);
	assert.match(endMessage(end), /"deploy" ended successfully \(exit code 0\)/);
	assert.match(endMessage(end), /It printed nothing\./);
});

test("a watch is stopped at its time limit, with the commands it started", async () => {
	const { list, nextEnd } = watches();
	list.start({ command: "echo started; sleep 30 & wait", description: "slow", cwd: work, timeoutMs: 300 });
	const end = await nextEnd();
	assert.equal(end.reason, "timeout");
	assert.match(endMessage(end), /was stopped at its time limit of 0s; the command had not ended/);
	assert.match(end.tail, /started/);
	assert.ok(end.durationMs < 5_000, "stopped with SIGTERM, not only after the kill grace");
});

test("stop ends a running watch and reports it; stopAll ends them without a report", async () => {
	const { list, nextEnd } = watches();
	const a = list.start({ command: "sleep 30", description: "a", cwd: work, timeoutMs: 60_000 });
	assert.equal(list.stop(a.id), true);
	assert.equal(list.stop(a.id), false, "stopping twice");
	assert.equal(list.stop(999), false);
	const end = await nextEnd();
	assert.equal(end.reason, "stopped");
	assert.match(endMessage(end), /"a" was stopped after/);

	let reported = false;
	const silent = new Watches({ onEnd: () => (reported = true) });
	silent.start({ command: "sleep 30", description: "b", cwd: work, timeoutMs: 60_000 });
	silent.stopAll();
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(silent.list(), []);
	assert.equal(reported, false);
});

test("the watch tool starts a watch in the agent's directory and checks its arguments", async () => {
	const { list, nextEnd } = watches();
	const host: Host = { pi: {} as any, ctx: () => undefined, sessionRules: new Set(), watches: list };
	const tool = (name: string) => bridgeTools(host).find((t) => t.name === name)!;
	const client = { provider: "claude-bag", kind: "claude" as const, data: { cwd: work } };

	const started = await tool("watch").call({ command: "sleep 30", description: "CI of PR #42", timeout_minutes: 5 }, client);
	assert.equal(started.isError, false);
	assert.match(started.text, /^Watch #\d+ started \(time limit 5m 0s\)\. .*End your turn now/);
	const listed = JSON.parse((await tool("watches").call({}, client)).text);
	assert.equal(listed.length, 1);
	assert.equal(listed[0].description, "CI of PR #42");
	assert.equal(listed[0].cwd, work);
	assert.equal(listed[0].timeLimit, "5m 0s");

	assert.equal((await tool("watch_stop").call({ id: listed[0].id }, client)).isError, false);
	const end = await nextEnd();
	assert.equal(end.reason, "stopped");
	assert.equal((await tool("watch_stop").call({ id: listed[0].id }, client)).isError, true);

	assert.equal((await tool("watch").call({ command: "  ", description: "x" }, client)).isError, true);
	assert.equal((await tool("watch").call({ command: "true", description: "x", cwd: join(work, "missing") }, client)).isError, true);
	const none: Host = { ...host, watches: undefined };
	assert.equal((await bridgeTools(none).find((t) => t.name === "watch")!.call({ command: "true", description: "x" }, client)).isError, true);
});

test("time limits, durations and output tails", () => {
	assert.equal(timeoutMsOf(undefined), 30 * 60_000);
	assert.equal(timeoutMsOf(0), 60_000);
	assert.equal(timeoutMsOf(10), 10 * 60_000);
	assert.equal(timeoutMsOf(10_000), 180 * 60_000);
	assert.equal(timeoutMsOf("15"), 30 * 60_000);

	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(45_400), "45s");
	assert.equal(formatElapsed(192_000), "3m 12s");
	assert.equal(formatElapsed(3_900_000), "1h 5m");

	const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n") + "\n\n";
	const tail = tailOf(many);
	assert.equal(tail.split("\n").length, 40);
	assert.ok(tail.startsWith("line 60") && tail.endsWith("line 99"));
	assert.equal(tailOf("x".repeat(10_000)).length, 4_000);
});

test("watches above the editor and their end in the chat", () => {
	const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
	const watch = { id: 2, description: "CI", command: "gh run watch 1", cwd: work, startedAt: 1_000, timeoutMs: 60_000 };
	assert.deepEqual(watchLines(theme, [watch], 73_000), ["<accent>⏳ <text>Waiting for CI<dim> · 1m 12s · #2 · /watches to stop"]);
	const end = { id: 2, description: "CI", durationMs: 5_000 };
	assert.equal(endHeadline(theme, { ...end, reason: "exited", exitCode: 0 }), "<success>✓ <text>Watch #2 CI: done<dim> · 5s");
	assert.equal(endHeadline(theme, { ...end, reason: "exited", exitCode: 1 }), "<error>✗ <text>Watch #2 CI: failed (exit code 1)<dim> · 5s");
	assert.equal(endHeadline(theme, { ...end, reason: "timeout", exitCode: null }), "<warning>⏱ <text>Watch #2 CI: reached its time limit<dim> · 5s");
	assert.equal(endHeadline(theme, { ...end, reason: "stopped", exitCode: null }), "<warning>■ <text>Watch #2 CI: stopped<dim> · 5s");
});
