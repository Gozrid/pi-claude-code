/**
 * pi-bridge: steps, the stepper an agent shows above the editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bridgeTools, type Host } from "../extensions/pi-bridge/tools.ts";
import { progressText, type StepColors, Stepper, stepLines, summary } from "../extensions/pi-bridge/steps.ts";

/** A theme with plain ANSI codes, so the tests see the colours. */
const CODES = { accent: 36, dim: 2, muted: 90, success: 32, error: 31, warning: 33, text: 39 } as const;
const theme: StepColors = {
	fg: (color, text) => `\x1b[${CODES[color]}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
};
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

const APP = ["Build APK", { title: "Check device", detail: "adb devices" }, "Install APK", "Start app"];

test("a stepper shows its steps in a row with where it is, and the running step's detail and time", () => {
	let now = 1_000;
	let changes = 0;
	const stepper = new Stepper({ now: () => now, onChange: () => changes++ });
	stepper.set("Install the app", APP);
	assert.equal(progressText(stepper.list!), "Step 1 of 4");
	stepper.update(1, "done");
	stepper.update(2, "running");
	now += 4_000;
	assert.equal(changes, 3);
	const lines = stepLines(theme, stepper.list!, 120, now, 2);
	assert.deepEqual(plain(lines), [
		"Install the app · Step 2 of 4",
		"✓ Build APK ── ⠹ Check device ── ○ Install APK ── ○ Start app",
		"  adb devices · 4s",
	]);
	assert.ok(lines[1].includes("\x1b[32m✓"));
	assert.ok(lines[1].includes("\x1b[1m\x1b[36mCheck device"));
	assert.ok(lines[1].includes("\x1b[2mStart app"));
});

test("too narrow for one row, the steps stand below each other, each line within the width", () => {
	const stepper = new Stepper({ now: () => 0 });
	stepper.set(undefined, APP);
	stepper.update(1, "failed", { note: "gradle error" });
	stepper.update("3", "skipped");
	const lines = stepLines(theme, stepper.list!, 30, 0);
	assert.deepEqual(plain(lines), ["Step 1 of 4", "✗ Build APK · gradle error", "○ Check device · adb devices", "↷ Install APK", "○ Start app"]);
	for (const line of stepLines(theme, stepper.list!, 12, 0)) assert.ok(visibleWidth(line) <= 12, line);
});

test("a finished list says how it ended and goes away by itself; an open one stays", async () => {
	let changes = 0;
	const stepper = new Stepper({ lingerMs: 30, onChange: () => changes++ });
	stepper.set("Deploy", [{ title: "Build", status: "running" }, "Ship"]);
	stepper.update(1, "done");
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(stepper.list, "open steps stay");
	stepper.update(2, "failed");
	assert.equal(progressText(stepper.list!), "Step 2 of 2 failed");
	assert.match(summary(stepper.list!), /goes away by itself/);
	// Back to running before it went away: it stays.
	stepper.update(2, "running");
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(stepper.list);
	stepper.update(2, "done");
	assert.equal(progressText(stepper.list!), "2 of 2 done");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(stepper.list, undefined);
	assert.equal(stepper.clear(), false);
	assert.equal(changes, 6);
});

test("the tools set, move on and clear the steps, and say what is wrong with bad input", async () => {
	const host: Host = { pi: {} as any, ctx: () => undefined, sessionRules: new Set(), steps: new Stepper() };
	const tools = bridgeTools(host);
	const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.call(args, { provider: "p", kind: "claude" } as any);

	assert.equal((await call("steps_update", { step: 1, status: "done" })).isError, true);
	assert.equal((await call("steps_set", { steps: [] })).isError, true);
	assert.match((await call("steps_set", { steps: [{ title: "" }] })).text, /Step 1 has no title/);
	assert.match((await call("steps_set", { steps: [{ title: "A", status: "busy" }] })).text, /unknown status busy/);

	const set = await call("steps_set", { title: "Install", steps: [{ title: "Build", status: "running" }, { title: "Install" }] });
	assert.equal(set.isError, false);
	assert.match(set.text, /^Install · Step 1 of 2\.\n1\. Build: running\n2\. Install: pending$/);
	const updated = await call("steps_update", { step: 2, status: "running", note: "Pixel 8" });
	assert.match(updated.text, /2\. Install: running \(Pixel 8\)/);
	assert.match((await call("steps_update", { step: 5, status: "done" })).text, /No step 5; the steps are 1\. Build, 2\. Install/);
	assert.equal((await call("steps_clear", {})).text, "Steps removed.");
	assert.equal(host.steps!.list, undefined);
	assert.equal((await call("steps_clear", {})).text, "No steps were shown.");
	host.steps!.clear();
});
