/**
 * pi's suggestion rows, moved into the frame above the editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { listMouse, splitCounter } from "../extensions/chat-view/command-list.ts";
import { frameRowAt } from "../extensions/chat-view/editor-frame.ts";

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

const mouse = (type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}) =>
	({ type, button: "left", x, y, screenX: x, screenY: y, width: 40, height: 6, shift: false, alt: false, ctrl: false, ...extra }) as TuiMouseEvent;

test("rows of a frame: below the top edge, between the side lines", () => {
	assert.equal(frameRowAt(mouse("click", 5, 0), 3), undefined);
	assert.equal(frameRowAt(mouse("click", 5, 1), 3), 0);
	assert.equal(frameRowAt(mouse("click", 5, 3), 3), 2);
	assert.equal(frameRowAt(mouse("click", 5, 4), 3), undefined);
	assert.equal(frameRowAt(mouse("click", 0, 1), 3), undefined);
	assert.equal(frameRowAt(mouse("click", 39, 1), 3), undefined);
});

test("a click on a suggestion goes to pi's list on its own row, the editor keeps the focus", () => {
	const seen: TuiMouseEvent[] = [];
	const list = {
		render: () => [],
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
			seen.push(event);
			return { handled: true, focus: true };
		},
	};
	assert.deepEqual(listMouse(list, mouse("click", 6, 2), 4), { handled: true });
	assert.equal(seen[0]!.y, 1);
	assert.equal(seen[0]!.x, 4);
	assert.equal(seen[0]!.width, 36);
	// The top edge is not a suggestion.
	assert.equal(listMouse(list, mouse("click", 6, 0), 4), undefined);
	// The wheel moves the selection wherever it is.
	assert.deepEqual(listMouse(list, mouse("wheel", 6, 0, { button: "none", wheelDelta: 1 }), 4), { handled: true });
	assert.equal(seen.at(-1)!.type, "wheel");
});
