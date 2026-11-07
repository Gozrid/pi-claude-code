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

test("a click on a tool block expands just that block, a click on a thought hides it; Ctrl+O sets all again", async () => {
	const { groupedMessages } = await import("../extensions/chat-view/grouped-messages.ts");
	const { Container } = await import("@earendil-works/pi-tui");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme("dark");
	const plain = (t: string) => t;
	const markdownTheme = Object.fromEntries(
		["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "underline", "strikethrough"].map(
			(key) => [key, plain],
		),
	);
	class AssistantMessageComponent extends Container {
		contentContainer = new Container();
		hideThinkingBlock = false;
		markdownTheme = markdownTheme;
		outputPad = 0;
		markdownTransformers = [];
		isStreaming = false;
		lastMessage: unknown;
		constructor() {
			super();
			this.addChild(this.contentContainer);
		}
		updateContent(message: unknown) {
			this.lastMessage = message;
			this.contentContainer.clear();
		}
		override invalidate() {
			if (this.lastMessage) this.updateContent(this.lastMessage);
		}
	}
	const theme = { fg: (_c: string, t: string) => t, style: (t: string) => t, bg: (_c: string, t: string) => t };
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
	const pi = { on: (event: string, handler: (typeof handlers)[string]) => (handlers[event] = handler), registerCommand() {} };
	const message = new AssistantMessageComponent();
	const tui = { children: [message], requestRender() {} };
	let widget: { render(width: number): string[] } | undefined;
	const ctx = { mode: "tui", ui: { setWidget: (_name: string, f: (ui: unknown, theme: unknown) => typeof widget) => (widget = f(tui, theme)), getToolsExpanded: () => false } };
	groupedMessages(pi as never);
	await handlers.session_start({}, ctx);

	const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	message.updateContent({
		content: [think("plan it"), text(`⏺ **Bash** \`ls\`\n\`\`\`\n${output}\n\`\`\``), text("⏺ **Read** `a.ts`"), text("Done.")],
	});
	widget!.render(80);
	const rows = () => message.render(80);
	const click = (needle: string) => {
		const y = rows().findIndex((row) => row.includes(needle));
		assert.ok(y >= 0, `${needle} is drawn`);
		return message.handleMouse({ type: "click", button: "left", x: 10, y, screenX: 10, screenY: y, width: 80, height: rows().length, shift: false, alt: false, ctrl: false });
	};

	assert.ok(rows().some((row) => row.includes("more lines · click or")), "collapsed, with the hint");
	assert.ok(!rows().some((row) => row.includes("line 20")));
	assert.ok(click("line 3"), "the click is handled");
	assert.ok(rows().some((row) => row.includes("line 20")), "the clicked block is expanded");
	click("line 20");
	assert.ok(!rows().some((row) => row.includes("line 20")), "and collapsed again");
	assert.equal(click("Read"), undefined, "a block without details has nothing to expand");

	click("line 3");
	(message as unknown as { setExpanded(e: boolean): void }).setExpanded(false);
	assert.ok(!rows().some((row) => row.includes("line 20")), "Ctrl+O sets every block again");

	assert.ok(rows().some((row) => row.includes("plan it")));
	click("Thinking");
	assert.ok(!rows().some((row) => row.includes("plan it")), "the clicked thought is hidden");
	assert.ok(rows().some((row) => row.includes("Thinking · hidden")));
	click("Thinking");
	assert.ok(rows().some((row) => row.includes("plan it")), "and shown again");

	await handlers.session_shutdown({}, ctx);
});
