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

test("a click on the pinned prompt scrolls the chat back to it", async () => {
	const { StickyPrompt } = await import("../extensions/chat-view/sticky-prompt.ts");
	class UserMessageComponent {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
		render() {
			return [this.text];
		}
	}
	class Container {
		children: unknown[];
		constructor(children: unknown[]) {
			this.children = children;
		}
		render() {
			return [];
		}
	}
	const filler = { render: () => Array.from({ length: 20 }, () => "answer") };
	const document = new Container([new UserMessageComponent("first"), filler, new UserMessageComponent("second"), filler]);
	let scrollTop = 5;
	const transcript = {
		get scrollTop() {
			return scrollTop;
		},
		primary: true,
		viewportHeight: 10,
		children: [document],
		getContentWidth: (width: number) => width,
		scrollTo: (row: number) => (scrollTop = row),
		render: () => [],
	};
	const tui = { getPrimaryScrollView: () => transcript, children: [] };
	const theme = { bg: (_c: string, t: string) => t, fg: (_c: string, t: string) => t };
	const sticky = new StickyPrompt(tui as never, () => theme as never);
	const click = (type: string, button = "left") =>
		sticky.handleMouse({ type, button, x: 1, y: 0, screenX: 1, screenY: 0, width: 40, height: 1, shift: false, alt: false, ctrl: false } as never);

	assert.deepEqual(sticky.render(40), ["first"]);
	assert.equal(click("click", "right"), undefined);
	assert.ok(click("press"), "the press does not start a selection");
	assert.ok(click("click"));
	assert.equal(scrollTop, 0, "back at the first prompt");

	scrollTop = 25;
	assert.deepEqual(sticky.render(40), ["second"]);
	click("click");
	assert.equal(scrollTop, 21);

	scrollTop = 21;
	assert.deepEqual(sticky.render(40), [], "nothing pinned while the prompt is in view");
	assert.equal(click("click"), undefined);
});
