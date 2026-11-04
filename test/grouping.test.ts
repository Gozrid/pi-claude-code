/**
 * Splitting an assistant message into its work and its answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupMessage } from "../extensions/chat-view/grouping.ts";

const think = (thinking: string) => ({ type: "thinking", thinking });
const text = (t: string) => ({ type: "text", text: t });

test("a plain answer has no work part", () => {
	assert.deepEqual(groupMessage([text("Hello")]), { work: [], answer: "Hello" });
});

test("consecutive thoughts and consecutive tool lines are grouped, in order", () => {
	const { work, answer } = groupMessage([
		think("look at the files"),
		think("then the tests"),
		text("⏺ **Bash** ` ls `"),
		text("⎿ ` a.ts b.ts `"),
		text("⏺ **Read** ` a.ts `"),
		text("✗ ` not found `"),
		think("now answer"),
		text("Here is what I found."),
		text("And one more thing."),
	]);
	assert.deepEqual(work, [
		{ kind: "thinking", texts: ["look at the files", "then the tests"], run: 0 },
		{ kind: "tools", texts: ["⏺ **Bash** ` ls `", "⎿ ` a.ts b.ts `", "⏺ **Read** ` a.ts `", "✗ ` not found `"], calls: 2 },
		{ kind: "thinking", texts: ["now answer"], run: 1 },
	]);
	assert.equal(answer, "Here is what I found.\n\nAnd one more thing.");
});

test("text between steps is a note, only text at the end is the answer", () => {
	const { work, answer } = groupMessage([text("Let me check."), text("⏺ **Bash** ` ls `"), text("Done.")]);
	assert.deepEqual(
		work.map((s) => s.kind),
		["remark", "tools"],
	);
	assert.equal(answer, "Done.");
});

test("a message that hands over to pi's tool calls has no answer yet", () => {
	const { work, answer } = groupMessage([think("read it"), text("Reading the file."), { type: "toolCall" }]);
	assert.equal(answer, undefined);
	assert.deepEqual(
		work.map((s) => s.kind),
		["thinking", "remark"],
	);
});

test("empty blocks are skipped", () => {
	assert.deepEqual(groupMessage([think("  "), text("")]), { work: [] });
});

test("while streaming, text at the end stays a note", () => {
	const content = [think("check"), text("⏺ **Bash** ` ls `"), text("Now the tests.")];
	const streaming = groupMessage(content, true);
	assert.equal(streaming.answer, undefined);
	assert.deepEqual(
		streaming.work.map((s) => s.kind),
		["thinking", "tools", "remark"],
	);
	assert.equal(groupMessage(content).answer, "Now the tests.");
});

test("pi's layout is put back on session_shutdown, so a reload does not run a wrapper with a stale ctx", async () => {
	const { groupedMessages } = await import("../extensions/chat-view/grouped-messages.ts");
	class AssistantMessageComponent {
		updateContent() {}
		invalidate() {}
	}
	const proto = AssistantMessageComponent.prototype as unknown as Record<string, unknown>;
	const original = proto.updateContent;
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
	const pi = { on: (event: string, handler: (typeof handlers)[string]) => (handlers[event] = handler), registerCommand() {} };
	const tui = { children: [new AssistantMessageComponent()], requestRender() {} };
	let widget: { render(width: number): string[] } | undefined;
	const ctx = { mode: "tui", ui: { setWidget: (_name: string, f: (ui: unknown, theme: unknown) => typeof widget) => (widget = f(tui, {})), getToolsExpanded: () => false } };
	groupedMessages(pi as never);

	await handlers.session_start({}, ctx);
	widget!.render(80);
	assert.notEqual(proto.updateContent, original);
	assert.ok("setExpanded" in proto);

	await handlers.session_shutdown({}, ctx);
	assert.equal(proto.updateContent, original);
	assert.ok(!("setExpanded" in proto));

	// pi lays out the chat again before the new session starts, with the old ctx already stale.
	Object.defineProperty(ctx, "ui", {
		get() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	widget!.render(80);
	assert.equal(proto.updateContent, original);
});
