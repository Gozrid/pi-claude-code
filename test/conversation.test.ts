/**
 * The conversation export as Markdown.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationMarkdown, exportFileName } from "../extensions/commands/conversation.ts";

const at = new Date("2026-10-29T20:15:00Z");

test("prompts, answers, thinking, tools and summaries become Markdown sections", () => {
	const md = conversationMarkdown(
		[
			{ type: "message", message: { role: "user", content: "Fix the test" } },
			{
				type: "message",
				message: {
					role: "assistant",
					model: "claude-opus-5-5",
					content: [
						{ type: "thinking", thinking: "Look at it first." },
						{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x" }], isError: false } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
			{ type: "compaction", summary: "Earlier we talked." },
			{ type: "custom", customType: "work-status" },
		],
		{ title: "Test fix", cwd: "/repo", exportedAt: at },
	);
	assert.match(md, /^# Test fix\n\n\*Exported 2026-10-29 20:15 UTC from `\/repo`\*/);
	assert.match(md, /## User\n\nFix the test/);
	assert.match(md, /## Assistant \(claude-opus-5-5\)\n\n<details>\n<summary>Thinking<\/summary>\n\nLook at it first\./);
	assert.match(md, /\*\*Tool call:\*\* `read`\n\n```json\n\{\n {2}"path": "a\.ts"\n\}\n```/);
	assert.match(md, /<summary>Result: <code>read<\/code><\/summary>\n\n```\nx\n```/);
	assert.match(md, /## Assistant\n\nDone\./);
	assert.match(md, /> \*\*Summary of earlier messages:\*\*\n>\n> Earlier we talked\./);
	assert.ok(!md.includes("work-status"));
});

test("code blocks in the content keep their fences", () => {
	const md = conversationMarkdown([
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: "```js\n1\n```", isError: true } },
	]);
	assert.match(md, /<summary>Result: <code>bash<\/code> \(error\)<\/summary>\n\n````\n```js\n1\n```\n````/);
});

test("file names come from the session name and the time", () => {
	assert.equal(exportFileName("Fix the README!", at), "pi-fix-the-readme-20261029-2015.md");
	assert.equal(exportFileName(undefined, at), "pi-conversation-20261029-2015.md");
});
