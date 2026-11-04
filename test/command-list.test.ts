/**
 * pi's suggestion rows, moved into the frame above the editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { splitCounter } from "../extensions/chat-view/command-list.ts";

test("the counter line moves out of the rows", () => {
	assert.deepEqual(splitCounter(["→ copy", "  compact", "\x1b[2m  (1/43)\x1b[0m"]), {
		rows: ["→ copy", "  compact"],
		counter: "1/43",
	});
});

test("without a counter the rows stay as they are", () => {
	assert.deepEqual(splitCounter(["→ copy", "  compact"]), { rows: ["→ copy", "  compact"] });
	assert.deepEqual(splitCounter([]), { rows: [] });
});
