/**
 * Code blocks with a line on the left instead of ``` fences.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown } from "@earendil-works/pi-tui";
import { barCodeBlocks } from "../extensions/chat-view/code-blocks.ts";

const plain = (t: string) => t;
const markdownTheme = () =>
	Object.fromEntries(
		["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "underline", "strikethrough"].map(
			(key) => [key, plain],
		),
	);
const theme = { fg: (_color: string, text: string) => text, style: (text: string) => text } as unknown as Parameters<typeof barCodeBlocks>[1];

test("the line bends into the language at the top and stays open at the bottom", () => {
	const md = markdownTheme();
	barCodeBlocks(md, theme);
	const rows = new Markdown("Text\n\n```typescript\nconst x = 1;\n```", 0, 0, md as never).render(40).map((row) => row.trimEnd());
	assert.deepEqual(rows, ["Text", "", "╭─ typescript", "│ const x = 1;", ""]);
});

test("without a language, and block after block, the corners still pair up", () => {
	const md = markdownTheme();
	barCodeBlocks(md, theme);
	const rows = new Markdown("```\nnpm test\n```\n\n```sh\nls\n```", 0, 0, md as never).render(40).map((row) => row.trimEnd());
	assert.deepEqual(rows, ["╭─", "│ npm test", "", "", "╭─ sh", "│ ls", ""]);
});

test("applying it twice changes nothing", () => {
	const md = markdownTheme();
	barCodeBlocks(md, theme);
	barCodeBlocks(md, theme);
	assert.equal((md as { codeBlockIndent?: string }).codeBlockIndent, "│ ");
});
