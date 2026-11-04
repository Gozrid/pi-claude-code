/**
 * The answer box's logic: which answer, how long the round took, which rows show.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { clampOffset, contentHeight, formatDuration, roundAnswer, wheelRows } from "../extensions/chat-view/answer.ts";

const text = (t: string) => ({ type: "text", text: t });
const assistant = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason });

test("the answer is what the last assistant message says after its last step", () => {
	const messages = [
		{ role: "user", content: "go" },
		assistant([text("first round")]),
		assistant([{ type: "thinking", thinking: "plan" }, text("⏺ **Bash** ` ls `"), text("Here it is."), text("And more.")]),
	];
	assert.equal(roundAnswer(messages), "Here it is.\n\nAnd more.");
});

test("no answer when the round was stopped, failed or ended on a tool call", () => {
	assert.equal(roundAnswer([assistant([text("half")], "aborted")]), undefined);
	assert.equal(roundAnswer([assistant([text("oops")], "error")]), undefined);
	assert.equal(roundAnswer([assistant([text("Let me check."), { type: "toolCall" }])]), undefined);
	assert.equal(roundAnswer([{ role: "user", content: "hi" }]), undefined);
});

test("durations read like the work-status line", () => {
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(130_400), "2m 10s");
});

test("the box is as high as the answer, at most two thirds of the terminal", () => {
	assert.equal(contentHeight(5, 60), 5);
	assert.equal(contentHeight(100, 60), 39);
	assert.equal(contentHeight(0, 60), 1);
});

test("scrolling stays within the answer", () => {
	assert.equal(clampOffset(-3, 50, 10), 0);
	assert.equal(clampOffset(45, 50, 10), 40);
	assert.equal(clampOffset(7, 5, 10), 0);
});

test("the mouse wheel over the box scrolls the box, not the chat; other mouse events pass", () => {
	assert.equal(wheelRows({ type: "wheel", wheelDelta: 3 }), 3);
	assert.equal(wheelRows({ type: "wheel", wheelDelta: -1 }), -1);
	assert.equal(wheelRows({ type: "click" }), undefined, "clicks still select text");
	assert.equal(wheelRows({ type: "drag" }), undefined);
});
