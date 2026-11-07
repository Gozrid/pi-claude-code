/**
 * Shell mode: ! and !! in the editor turn its borders purple, !! greys the text,
 * and a grey hint says where the output goes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import { greyed, HINTS, shellMode, sweepAt, SWEEP_MS, withHint, wrap } from "../extensions/chat-view/shell-mode.ts";

const BLUE = "\x1b[34m";
const PINK = "\x1b[35m";
const GREY = "\x1b[90m";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g, "");

test("one ! sends the output to the model, two keep it, anything else is no shell", () => {
	assert.equal(shellMode("!ls"), "context");
	assert.equal(shellMode("  !ls"), "context");
	assert.equal(shellMode("!!ls"), "private");
	assert.equal(shellMode("ls !"), undefined);
	assert.equal(shellMode(""), undefined);
});

test("the sweep runs from the left, the head between old and new", () => {
	assert.equal(sweepAt(0, 40, 0), "old");
	assert.equal(sweepAt(39, 40, 0.1), "old");
	assert.equal(sweepAt(0, 40, 0.6), "new");
	assert.equal(sweepAt(39, 40, 1), "new");
	const mid = [...Array(40).keys()].map((i) => sweepAt(i, 40, 0.3));
	assert.ok(mid.some((at) => typeof at === "number"), "a head somewhere in the middle");
	assert.equal(mid[0], "new");
	assert.equal(mid[39], "old");
	// Leaving: from the right.
	assert.equal(sweepAt(39, 40, 0.6, true), "new");
	assert.equal(sweepAt(0, 40, 0.1, true), "old");
});

test("the hint takes the row's trailing spaces, or does not fit", () => {
	const row = `!ls${" ".repeat(37)}`;
	const placed = withHint(row, "hint", 40)!;
	assert.equal(strip(placed).length, 40);
	assert.ok(strip(placed).endsWith("hint "));
	assert.equal(withHint(`${"x".repeat(36)}    `, "hint", 40), undefined);
});

test("greying survives colour resets inside the row", () => {
	const row = greyed("a\x1b[39mb\x1b[0mc", "<g>");
	assert.equal(row, "<g>a\x1b[39m<g>b\x1b[0m<g>c\x1b[39m");
});

function setup(text: string) {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 60 } } as any;
	const theme = {
		appearance: "dark",
		getColorMode: () => "truecolor",
		fg: (_c: string, s: string) => `\x1b[2m${s}\x1b[22m`,
		getFgAnsi: () => GREY,
	} as any;
	const selectList = { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s };
	const editor = new Editor(tui, { borderColor: (s: string) => `${BLUE}${s}\x1b[39m`, selectList }, {}) as any;
	editor.focused = true;
	wrap(editor, tui, theme);
	editor.setText(text);
	return editor;
}

test("without ! the editor looks as before", () => {
	const editor = setup("hello");
	const lines: string[] = editor.render(50);
	assert.ok(lines[0].startsWith(BLUE));
	assert.ok(!lines.join("").includes("shell"));
});

test("! turns the borders purple once the sweep is done and adds the hint", async () => {
	const editor = setup("!ls");
	editor.render(50);
	await new Promise((resolve) => setTimeout(resolve, SWEEP_MS + 30));
	const lines: string[] = editor.render(50);
	assert.ok(lines[0].startsWith("\x1b[38;2;178;122;255m"), JSON.stringify(lines[0]));
	assert.ok(lines[1].includes(`\x1b[2m${HINTS.context}\x1b[22m`));
	assert.equal(strip(lines[1]).length, 50);
	assert.ok(!lines[1].includes(GREY));
	// pi setting its own colour for ! does not end the purple.
	editor.borderColor = (s: string) => `\x1b[32m${s}\x1b[39m`;
	assert.ok(editor.render(50)[0].startsWith("\x1b[38;2;"));
});

test("!! greys the text and says the output stays", () => {
	const editor = setup("!!ls");
	const lines: string[] = editor.render(50);
	assert.ok(lines[1].startsWith(GREY));
	assert.ok(lines[1].includes(HINTS.private));
});

test("leaving the mode sweeps back to the colour pi set", async () => {
	const editor = setup("!ls");
	editor.render(50);
	editor.borderColor = (s: string) => `\x1b[32m${s}\x1b[39m`;
	editor.setText("ls");
	editor.borderColor = (s: string) => `${PINK}${s}\x1b[39m`;
	editor.render(50);
	await new Promise((resolve) => setTimeout(resolve, SWEEP_MS + 30));
	assert.ok(editor.render(50)[0].startsWith(PINK));
});
