/**
 * Which user message sticks to the top of the transcript.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedRows } from "../extensions/chat-view/sticky.ts";

// Two prompts of 3 rows, at rows 10 and 40.
const messages = [
	{ start: 10, end: 13 },
	{ start: 40, end: 43 },
];

test("nothing is pinned while the first prompt is in view", () => {
	assert.equal(pinnedRows(messages, 0, 4), undefined);
	assert.equal(pinnedRows(messages, 10, 4), undefined);
});

test("a prompt sticks once it scrolls out at the top", () => {
	assert.deepEqual(pinnedRows(messages, 11, 4), { index: 0, hiddenRows: 0 });
	assert.deepEqual(pinnedRows(messages, 30, 4), { index: 0, hiddenRows: 0 });
});

test("the next prompt pushes it out as it comes up", () => {
	assert.deepEqual(pinnedRows(messages, 38, 4), { index: 0, hiddenRows: 1 });
	assert.deepEqual(pinnedRows(messages, 39, 4), { index: 0, hiddenRows: 2 });
	assert.equal(pinnedRows(messages, 40, 4), undefined);
	assert.deepEqual(pinnedRows(messages, 41, 4), { index: 1, hiddenRows: 0 });
});

test("long prompts pin only their first rows", () => {
	const long = [
		{ start: 0, end: 20 },
		{ start: 30, end: 32 },
	];
	assert.deepEqual(pinnedRows(long, 25, 4), { index: 0, hiddenRows: 0 });
	assert.deepEqual(pinnedRows(long, 27, 4), { index: 0, hiddenRows: 1 });
});
