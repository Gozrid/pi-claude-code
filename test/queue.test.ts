/**
 * Steering and queued messages while the agent works.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { hintAt, hintsLine, keySymbol, MessageQueue, queueClick, queueLines } from "../extensions/chat-view/queue.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	style: (text: string) => text,
} as unknown as Parameters<typeof queueLines>[0];
const keys = { steer: "enter", now: "ctrl+enter", queue: "option+enter", edit: "option+up", stop: "escape" };

test("steering comes before queued messages, as pi delivers them", () => {
	const queue = new MessageQueue();
	queue.add("followUp", "then the README");
	queue.add("steer", "fix the test first");
	assert.deepEqual(
		queue.messages.map((m) => m.text),
		["fix the test first", "then the README"],
	);
});

test("a delivered message leaves the queue, a changed one takes the next in line", () => {
	const queue = new MessageQueue();
	queue.add("followUp", "later");
	queue.add("steer", "/review now");
	queue.delivered("later");
	assert.deepEqual(queue.messages.map((m) => m.text), ["/review now"]);
	queue.delivered("Review the code now (expanded from a template)");
	assert.equal(queue.messages.length, 0);
});

test("settling keeps messages pi has not had time to queue", () => {
	const queue = new MessageQueue();
	queue.add("steer", "old", 0);
	queue.add("steer", "new", 5000);
	queue.settle(5200);
	assert.deepEqual(queue.messages.map((m) => m.text), ["new"]);
});

test("the keys show right-aligned while the agent works, also with nothing waiting", () => {
	const hints = "enter steer (after this step) · ctrl+enter steer now · option+enter queue (when done) · escape stop ";
	const { lines, hintsWidth } = queueLines(theme, [], keys, 200);
	assert.deepEqual(lines, [" ".repeat(200 - hints.length) + hints]);
	assert.equal(hintsWidth, hints.length);
});

test("waiting messages are listed on one line each, with the key to edit them", () => {
	const { lines } = queueLines(
		theme,
		[
			{ kind: "steer", text: "fix\nthe   test", at: 0 },
			{ kind: "followUp", text: "update the README", at: 0 },
		],
		keys,
		200,
	);
	assert.deepEqual(lines.slice(0, 2), [" ↪ Steer  fix the test", " ◷ Queued update the README"]);
	assert.match(lines[2]!, /option\+up edit waiting/);
	for (const line of queueLines(theme, [{ kind: "steer", text: "x".repeat(300), at: 0 }], keys, 40).lines) {
		assert.ok(visibleWidth(line) <= 40, line);
	}
});

test("beside the crab the keys are symbols and the words short", () => {
	assert.equal(keySymbol("option+enter"), "⌥↵");
	assert.equal(keySymbol("ctrl+enter"), "⌃↵");
	assert.equal(keySymbol("escape"), "esc");
	assert.equal(hintsLine(theme, keys, false, true), "↵ steer · ⌃↵ now · ⌥↵ queue · esc stop ");
	assert.match(hintsLine(theme, keys, true, true), /⌥↑ edit/);
});

test("without the hints row, only the waiting messages are listed", () => {
	const { lines, hintsWidth } = queueLines(theme, [{ kind: "steer", text: "now", at: 0 }], keys, 80, false);
	assert.deepEqual(lines, [" ↪ Steer  now"]);
	assert.equal(hintsWidth, 0);
});

test("a click on a hint does what its key does", () => {
	const line = hintsLine(theme, keys, true);
	const at = (word: string) => hintAt(keys, true, line.indexOf(word));
	assert.equal(at("enter steer"), "steer");
	assert.equal(at("ctrl+enter"), "now");
	assert.equal(at("queue (when"), "queue");
	assert.equal(at("edit waiting"), "edit");
	assert.equal(at("escape stop"), "stop");
	assert.equal(hintAt(keys, true, line.indexOf(" · ") + 1), undefined);
	const compact = hintsLine(theme, keys, false, true);
	assert.equal(hintAt(keys, false, compact.indexOf("esc"), true), "stop");
});

test("clicks on the panel: waiting messages go back to the editor, the hints row is right-aligned", () => {
	const { hintsWidth } = queueLines(theme, [{ kind: "steer", text: "x", at: 0 }], keys, 200);
	const start = 200 - hintsWidth;
	assert.equal(queueClick(keys, 1, true, hintsWidth, 200, 3, 0), "edit");
	assert.equal(queueClick(keys, 1, true, hintsWidth, 200, start, 1), "steer");
	assert.equal(queueClick(keys, 1, true, hintsWidth, 200, start - 1, 1), undefined);
	assert.equal(queueClick(keys, 1, true, hintsWidth, 200, 199, 1), undefined);
	assert.equal(queueClick(keys, 1, true, hintsWidth, 200, start + hintsWidth - 3, 1), "stop");
	// chat-crab shows the hints: no hints row.
	assert.equal(queueClick(keys, 1, false, 0, 200, 150, 1), undefined);
});
