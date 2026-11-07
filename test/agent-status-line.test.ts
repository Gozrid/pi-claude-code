import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutSegments, MODE_ANIMATION_MS, modeSegment, segmentAt, wrapSegments } from "../extensions/agent-status-line/index.ts";

const parts = ["aaaa", "bbbbbb", "cc", "dddddddd"];

test("everything on one line when it fits", () => {
	assert.deepEqual(wrapSegments(parts, " | ", 80), ["aaaa | bbbbbb | cc | dddddddd"]);
});

test("wraps between segments, never inside one", () => {
	assert.deepEqual(wrapSegments(parts, " | ", 15), ["aaaa | bbbbbb", "cc | dddddddd"]);
	assert.deepEqual(wrapSegments(parts, " | ", 8), ["aaaa", "bbbbbb", "cc", "dddddddd"]);
});

test("a segment wider than the line is cut to the width", () => {
	const lines = wrapSegments(parts, " | ", 5);
	assert.equal(lines.length, 4);
	for (const line of lines) assert.ok(visibleWidth(line) <= 5, line);
});

test("ANSI colours do not count towards the width", () => {
	const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
	assert.deepEqual(wrapSegments([red("aaaa"), red("bbbb")], " | ", 11).length, 1);
});

// Marks styling instead of colouring, so the frames can be read as text.
const theme = {
	fg: (_color: string, text: string) => text,
	style: (text: string, options: { fg?: string; inverse?: boolean }) =>
		options.inverse ? `[${text}]` : options.fg === "text" ? `*${text}*` : text,
} as unknown as Parameters<typeof modeSegment>[0];

test("the mode stands still when it was not switched", () => {
	assert.equal(modeSegment(theme, "plan"), "⏸ plan (shift+tab)");
	assert.equal(modeSegment(theme, "plan", MODE_ANIMATION_MS), "⏸ plan (shift+tab)");
});

test("a switched mode is typed in behind a cursor, then shines", () => {
	assert.equal(modeSegment(theme, "plan", 0), "[⏸]      (shift+tab)");
	assert.match(modeSegment(theme, "plan", MODE_ANIMATION_MS * 0.3), /^⏸ ?p?\[.\] *\(shift\+tab\)$/);
	assert.match(modeSegment(theme, "plan", MODE_ANIMATION_MS * 0.8), /\*[^*]+\*/);
});

test("the label keeps its width while it animates", () => {
	const width = visibleWidth(modeSegment(theme, "acceptEdits"));
	for (let t = 0; t < MODE_ANIMATION_MS; t += 20) {
		const frame = modeSegment(theme, "acceptEdits", t).replace(/[[\]*]/g, "");
		assert.equal(visibleWidth(frame), width, `${t} ms: ${frame}`);
	}
});

test("knows where each segment stands, for clicks", () => {
	const parts = ["aaaa", "bbbbbb", "cc", "dddddddd"];
	const { lines, spans } = layoutSegments(parts, " | ", 15);
	assert.deepEqual(lines, ["aaaa | bbbbbb", "cc | dddddddd"]);
	assert.deepEqual(spans, [
		{ line: 0, from: 0, to: 4 },
		{ line: 0, from: 7, to: 13 },
		{ line: 1, from: 0, to: 2 },
		{ line: 1, from: 5, to: 13 },
	]);
	assert.equal(segmentAt(spans, 0, 0), 0);
	assert.equal(segmentAt(spans, 5, 0), -1);
	assert.equal(segmentAt(spans, 8, 0), 1);
	assert.equal(segmentAt(spans, 6, 1), 3);
	assert.equal(segmentAt(spans, 0, 2), -1);
});
