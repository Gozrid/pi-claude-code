/**
 * commands: the effort picker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { effortPicker } from "../extensions/commands/effort-picker.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

function picker() {
	let result: string | undefined | null = null;
	const p = effortPicker(theme as any, "Effort", LEVELS, "high", {}, () => {}, (level) => {
		result = level;
	});
	const lines = p.render(80);
	const click = (x: number, y: number, clickCount = 1) =>
		p.handleMouse!({ type: "click", button: "left", x, y, width: 80, height: lines.length, clickCount } as any);
	return { p, lines, click, result: () => result };
}

test("a click on a level picks it, a second click on it confirms", () => {
	const { p, lines, click, result } = picker();
	const labels = lines[4];
	click(labels.indexOf("max") + 1, 4);
	assert.equal(result(), null);
	assert.match(p.render(80)[6], /max/);
	const track = p.render(80)[3];
	click(track.indexOf("◉"), 3);
	assert.equal(result(), "max");
});

test("a double click confirms right away, the wheel moves, clicks elsewhere change nothing", () => {
	const { p, lines, click, result } = picker();
	p.handleMouse!({ type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -1 } as any);
	assert.match(p.render(80)[6], /^ {2}medium/);
	click(5, 1);
	assert.equal(result(), null);
	click(lines[4].indexOf("low"), 4, 2);
	assert.equal(result(), "low");
});
