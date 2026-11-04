/**
 * The prompt history list: prompts of a session, selection, scrolling and animation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { animatedRows, HISTORY_ROWS, HistoryBrowser, userPrompts } from "../extensions/chat-view/history.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<HistoryBrowser["lines"]>[0];
const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });

test("takes the user's prompts in order, text parts joined, blanks left out", () => {
	const entries = [
		user("first"),
		{ type: "message", message: { role: "assistant", content: "answer" } },
		{ type: "model_change" },
		user([{ type: "text", text: "second " }, { type: "image" }, { type: "text", text: "part" }]),
		user("   "),
	];
	assert.deepEqual(userPrompts(entries), ["first", "second part"]);
});

test("starts at the newest prompt and walks up and down within the list", () => {
	const browser = new HistoryBrowser(["a", "b", "c"]);
	assert.equal(browser.current, "c");
	assert.ok(browser.move(-1));
	assert.ok(browser.move(-1));
	assert.equal(browser.current, "a");
	assert.equal(browser.move(-1), false);
	assert.ok(browser.move(1));
	assert.ok(browser.move(1));
	assert.equal(browser.move(1), false);
	assert.equal(browser.current, "c");
});

test("shows the newest rows at the bottom, the selected one marked, on one line each", () => {
	const browser = new HistoryBrowser(["a", "b\nwith more", "c"]);
	browser.move(-1);
	assert.deepEqual(browser.lines(theme, 40), ["  a", "▸ b with more", "  c"]);
});

test("scrolls when the selection leaves the rows in view", () => {
	const prompts = Array.from({ length: HISTORY_ROWS + 3 }, (_, i) => `p${i}`);
	const browser = new HistoryBrowser(prompts);
	assert.equal(browser.height, HISTORY_ROWS);
	assert.equal(browser.lines(theme, 40)[0], "  p3");
	for (let i = 0; i < HISTORY_ROWS; i++) browser.move(-1);
	const lines = browser.lines(theme, 40);
	assert.equal(lines.length, HISTORY_ROWS);
	assert.equal(lines[0], "▸ p2");
});

test("while growing, only the bottom rows show", () => {
	const browser = new HistoryBrowser(["a", "b", "c"]);
	assert.deepEqual(browser.lines(theme, 40, 1), ["▸ c"]);
	assert.deepEqual(browser.lines(theme, 40, 0), []);
});

test("grows and shrinks one row per step, never past the target", () => {
	assert.equal(animatedRows(0, 5, 0, 20), 0);
	assert.equal(animatedRows(0, 5, 45, 20), 2);
	assert.equal(animatedRows(0, 5, 1000, 20), 5);
	assert.equal(animatedRows(5, 0, 25, 20), 4);
	assert.equal(animatedRows(5, 0, 1000, 20), 0);
});
