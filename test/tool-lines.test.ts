/**
 * The tool blocks the CLI providers write, and how chat-view takes them apart.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyParts, numberLines, splitToolBlock } from "../extensions/chat-view/tool-blocks.ts";
import { jsonTable, mcpTool, numberedText, toolCallBlock, toolResultBlock } from "../extensions/shared/tool-lines.ts";

const cwd = "/proj";

test("names MCP tools by server and tool", () => {
	assert.deepEqual(mcpTool("mcp__freecad__get_objects"), { server: "FreeCAD", tool: "get_objects" });
	assert.deepEqual(mcpTool("mcp__claude_ai_Gmail__search"), { server: "Gmail", tool: "search" });
	assert.deepEqual(mcpTool("mcp__my-docs__find"), { server: "My docs", tool: "find" });
	assert.equal(mcpTool("Bash"), undefined);
});

test("a Bash call shows its description in the header and the command highlighted below", () => {
	assert.equal(toolCallBlock("Bash", { command: "ls" }, cwd), "⏺ **Bash** ` ls `");
	assert.equal(
		toolCallBlock("Bash", { command: "npm test", description: "Run the tests" }, cwd),
		"⏺ **Bash** Run the tests\n\n```bash\nnpm test\n```",
	);
});

test("Read, Grep and edits show the path relative to the project", () => {
	assert.equal(toolCallBlock("Read", { file_path: "/proj/a.ts", offset: 10, limit: 5 }, cwd), "⏺ **Read** ` a.ts ` · lines 10–14");
	assert.equal(toolCallBlock("Grep", { pattern: "foo", path: "/proj/src" }, cwd), "⏺ **Grep** ` foo ` in ` src `");
	assert.equal(toolCallBlock("Edit", { file_path: "/proj/a.ts", old_string: "a", new_string: "b" }, cwd), "⏺ **Edit** ` a.ts `");
});

test("an MCP call names what it works on, shows code as code and the other arguments as JSON", () => {
	assert.equal(
		toolCallBlock("mcp__freecad__create_object", { doc_name: "Remote", obj_name: "Box", obj_type: "Part::Box" }, cwd),
		'⏺ **FreeCAD › create_object** ` Remote · Box `\n\n```json\n{\n  "obj_type": "Part::Box"\n}\n```',
	);
	assert.equal(toolCallBlock("mcp__freecad__get_view", { view_name: "Isometric" }, cwd), "⏺ **FreeCAD › get_view** ` Isometric `");
	assert.equal(toolCallBlock("mcp__db__run", { sql: "select 1" }, cwd), "⏺ **Db › run**\n\n```sql\nselect 1\n```");
});

test("a list of objects becomes a table with its plain fields first", () => {
	const table = jsonTable([
		{ Placement: { x: 0 }, Name: "Body", Label: "A|B" },
		{ Name: "Pad", Label: "Pad", Placement: { x: 5 } },
	]);
	assert.equal(
		table,
		'| Name | Label | Placement |\n| --- | --- | --- |\n| Body | A\\|B | {"x":0} |\n| Pad | Pad | {"x":5} |',
	);
	assert.equal(jsonTable([1, 2]), undefined);
	assert.equal(jsonTable({ a: 1 }), undefined);
});

test("results: short output inline, JSON indented, long output below, errors in plain text", () => {
	assert.equal(toolResultBlock("done\n"), "⎿ ` done `");
	assert.equal(toolResultBlock(""), "⎿ (no output)");
	assert.equal(toolResultBlock('{"a":1}'), '⎿ JSON · 3 lines\n\n```json\n{\n  "a": 1\n}\n```');
	assert.equal(toolResultBlock("a\nb"), "⎿ 2 lines\n\n```\na\nb\n```");
	assert.equal(toolResultBlock("Exit code 1\nboom", { isError: true }), "✗ Exit code 1\n\n```\nExit code 1\nboom\n```");
	assert.equal(toolResultBlock("", { images: ["/tmp/v.png"] }), "⎿ 1 image\n\n![image 1](/tmp/v.png)");
	assert.equal(toolResultBlock("ok", { name: "Bash" }), "⎿ **Bash** · ` ok `");
});

test("long output is cut in the message", () => {
	const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
	const block = toolResultBlock(text);
	assert.ok(block.includes("line 299\n… 200 more lines\n```"));
	assert.ok(!block.includes("line 300"));
});

test("file contents lose the tool's line numbers and keep where they start", () => {
	assert.deepEqual(numberedText("    7→a\n    8→b\n"), { content: "a\nb", startLine: 7 });
	assert.deepEqual(numberedText("     1\tx"), { content: "x", startLine: 1 });
	assert.equal(numberedText("7→a\n9→b"), undefined);
	assert.equal(toolResultBlock("    7→a\n    8→b", { file: { path: "/p/x.py" } }), "⎿ 2 lines\n\n```python:7\na\nb\n```");
});

test("chat-view splits a block into header, Markdown and images", () => {
	assert.deepEqual(splitToolBlock("⏺ **Bash** ` ls `"), { mark: "⏺", header: "**Bash** ` ls `", body: "" });
	assert.deepEqual(bodyParts("```\nout\n```\n\n![image 1](/tmp/a.png)"), [
		{ kind: "markdown", text: "```\nout\n```" },
		{ kind: "image", alt: "image 1", path: "/tmp/a.png" },
	]);
	assert.deepEqual(
		numberLines(["a", "b"], 9, (s) => `<${s}>`),
		["< 9 │> a", "<10 │> b"],
	);
});

const themeStub = { fg: (_: string, s: string) => s, style: (s: string) => s, bold: (s: string) => s } as any;

test("pi's own MCP tools get the same blocks; other tools and own renderers stay", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme("dark");
	const { mcpTools } = await import("../extensions/chat-view/mcp-tools.ts");
	let resolver: any;
	mcpTools({ registerToolRenderer: (r: unknown) => (resolver = r) } as any);
	assert.equal(resolver("bash", () => undefined), undefined);
	const own = { renderCall: () => undefined };
	assert.equal(resolver("mcp__freecad__get_view", () => own), own);
	const r = resolver("mcp__freecad__execute_code", () => undefined);
	const rows = r
		.renderCall({ code: "print(1)" }, themeStub, { cwd: "/p", expanded: false })
		.render(60)
		.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	assert.equal(rows[0], "⏺ FreeCAD › execute_code");
	assert.ok(rows.some((l: string) => l.includes("print(1)")));
});
