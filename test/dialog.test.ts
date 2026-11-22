/**
 * The popup dialogs' frame and how the mouse closes them: the ✕ in the frame
 * and a click outside.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { closable, closeClicked, dialogFrame } from "../extensions/shared/dialog.ts";

const theme = { fg: (_c: string, t: string) => t } as any;

test("the dialog has a rounded frame with the title and ✕ on top and the keys below", () => {
	const lines = dialogFrame(theme, 24, "Plan usage", "esc close", ["a".padEnd(20), "b".padEnd(20)]);
	assert.deepEqual(lines, [
		"╭─ Plan usage ───── ✕ ─╮",
		"│ a                    │",
		"│ b                    │",
		"╰─ esc close ──────────╯",
	]);
	assert.equal(visibleWidth(dialogFrame(theme, 14, "a very long title", "", [])[0]), 14);
	assert.equal(dialogFrame(theme, 12, "", "", [])[0], "╭────── ✕ ─╮");
	// While it unfolds and is still narrow, there is no room for the ✕.
	assert.equal(dialogFrame(theme, 8, "", "", [])[0], "╭──────╮");
});

test("a left click on the ✕ or the cell next to it is a click on the close button", () => {
	for (const x of [35, 36, 37]) assert.ok(closeClicked({ type: "click", button: "left", x, y: 0 }, 40), `x ${x}`);
	assert.ok(!closeClicked({ type: "click", button: "left", x: 36, y: 1 }, 40), "not in the text");
	assert.ok(!closeClicked({ type: "click", button: "left", x: 10, y: 0 }, 40), "not on the title");
	assert.ok(!closeClicked({ type: "click", button: "right", x: 36, y: 0 }, 40));
	assert.ok(!closeClicked({ type: "press", button: "left", x: 36, y: 0 }, 40));
});

/** pi-tui's alternate-screen renderer as far as the mouse goes: overlays laid out on screen. */
class FakeRenderer {
	renderedOverlayLayouts: { row: number; col: number; width: number; height: number; entry: { component: unknown } }[] = [];
	dispatchMouseToOverlay(event: any) {
		for (let i = this.renderedOverlayLayouts.length - 1; i >= 0; i--) {
			const l = this.renderedOverlayLayouts[i];
			if (event.screenX >= l.col && event.screenX < l.col + l.width && event.screenY >= l.row && event.screenY < l.row + l.height) {
				return { hit: true, result: { handled: true, layer: i } };
			}
		}
		return { hit: false };
	}
}

/** Like pi's renderer reference: every read of a method gives a new function. */
function piProxy(tui: object): any {
	return new Proxy(
		{},
		{
			get: (_t, p) => {
				const v = Reflect.get(tui, p, tui);
				return typeof v === "function" ? (...args: unknown[]) => Reflect.apply(v, tui, args) : v;
			},
			set: (_t, p, v) => Reflect.set(tui, p, v, tui),
			getPrototypeOf: () => Reflect.getPrototypeOf(tui),
		},
	);
}

const mouse = (type: string, x: number, y: number, button = "left") => ({
	type,
	button,
	x,
	y,
	screenX: x,
	screenY: y,
	width: 80,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
});

function openDialog(tui: FakeRenderer) {
	let closed = 0;
	let disposed = 0;
	const seen: string[] = [];
	const dialog = closable(
		piProxy(tui),
		{
			render: () => [],
			invalidate() {},
			handleMouse: (e: any) => {
				seen.push(`${e.type}@${e.x},${e.y}`);
				return { handled: true };
			},
			dispose: () => disposed++,
		},
		() => closed++,
	);
	tui.renderedOverlayLayouts.push({ row: 2, col: 10, width: 40, height: 10, entry: { component: dialog } });
	return { dialog, seen, closed: () => closed, disposed: () => disposed };
}

test("a click outside the dialog closes it; the press and release before it do not reach the chat", () => {
	const tui = new FakeRenderer();
	const { closed } = openDialog(tui);
	const press = tui.dispatchMouseToOverlay(mouse("press", 1, 1)) as any;
	assert.equal(press.hit, true);
	assert.equal(press.result.handled, true);
	assert.equal(closed(), 0, "a press alone does not close");
	// pi sends the release and the click to the press's target.
	const catcher = press.result.target.component;
	catcher.handleMouse(mouse("release", 1, 1));
	assert.equal(closed(), 0);
	catcher.handleMouse(mouse("click", 1, 1));
	assert.equal(closed(), 1);
});

test("the wheel outside the dialog is swallowed, so the chat does not scroll; a right click does not close", () => {
	const tui = new FakeRenderer();
	const { closed } = openDialog(tui);
	assert.equal((tui.dispatchMouseToOverlay({ ...mouse("wheel", 1, 1, "none"), wheelDelta: 3 }) as any).hit, true);
	tui.dispatchMouseToOverlay(mouse("click", 1, 1, "right"));
	assert.equal(closed(), 0);
});

test("inside the dialog pi dispatches as usual; the ✕ closes it", () => {
	const tui = new FakeRenderer();
	const { dialog, seen, closed } = openDialog(tui);
	assert.deepEqual(tui.dispatchMouseToOverlay(mouse("click", 20, 5)), { hit: true, result: { handled: true, layer: 0 } });
	assert.equal(closed(), 0);
	// The dialog gets coordinates of its own; the ✕ of a frame 40 wide is at column 36.
	assert.deepEqual(dialog.handleMouse!({ ...mouse("press", 36, 0), width: 40, height: 10 } as any), { handled: true, render: false });
	assert.equal(closed(), 0);
	dialog.handleMouse!({ ...mouse("click", 36, 0), width: 40, height: 10 } as any);
	assert.equal(closed(), 1);
	dialog.handleMouse!({ ...mouse("click", 5, 3), width: 40, height: 10 } as any);
	assert.deepEqual(seen, ["click@5,3"], "other clicks reach the dialog");
});

test("an overlay opened above the dialog keeps its clicks; once the dialog is gone the chat gets them again", () => {
	const tui = new FakeRenderer();
	const { dialog, closed, disposed } = openDialog(tui);
	tui.renderedOverlayLayouts.push({ row: 0, col: 0, width: 5, height: 1, entry: { component: {} } });
	assert.deepEqual(tui.dispatchMouseToOverlay(mouse("click", 1, 0)), { hit: true, result: { handled: true, layer: 1 } });
	assert.equal(closed(), 0);
	tui.renderedOverlayLayouts.pop();
	dialog.dispose!();
	assert.equal(disposed(), 1);
	tui.renderedOverlayLayouts.pop();
	assert.deepEqual(tui.dispatchMouseToOverlay(mouse("click", 1, 1)), { hit: false });
	assert.equal(closed(), 0);
});

test("an overlay below the dialog (the pinned prompt) counts as outside", () => {
	const tui = new FakeRenderer();
	tui.renderedOverlayLayouts.push({ row: 0, col: 0, width: 80, height: 1, entry: { component: {} } });
	const { closed } = openDialog(tui);
	tui.dispatchMouseToOverlay(mouse("click", 1, 0));
	assert.equal(closed(), 1);
});

test("dialogs opened on top of each other close one at a time, the last one first", () => {
	const tui = new FakeRenderer();
	const first = openDialog(tui);
	const second = openDialog(tui);
	tui.dispatchMouseToOverlay(mouse("click", 1, 1));
	assert.equal(second.closed(), 1);
	assert.equal(first.closed(), 0);
	tui.renderedOverlayLayouts.pop();
	tui.dispatchMouseToOverlay(mouse("click", 1, 1));
	assert.equal(first.closed(), 1);
});
