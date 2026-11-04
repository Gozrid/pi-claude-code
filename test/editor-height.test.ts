/**
 * The editor's text rows while it grows or shrinks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { animatedText } from "../extensions/chat-view/editor-height.ts";

test("growing shows the bottom rows when the cursor is at the end", () => {
	assert.deepEqual(animatedText(["a", "b", "c", `d${CURSOR_MARKER}`], 2), ["c", `d${CURSOR_MARKER}`]);
});

test("growing keeps the cursor's row in view", () => {
	assert.deepEqual(animatedText([`a${CURSOR_MARKER}`, "b", "c", "d"], 2), [`a${CURSOR_MARKER}`, "b"]);
	assert.deepEqual(animatedText(["a", `b${CURSOR_MARKER}`, "c", "d"], 1), [`b${CURSOR_MARKER}`]);
});

test("shrinking pads with empty rows", () => {
	assert.deepEqual(animatedText(["a"], 3), ["a", "", ""]);
});
