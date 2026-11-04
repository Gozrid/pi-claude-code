import assert from "node:assert/strict";
import { test } from "node:test";
import { editDiff } from "../extensions/claude-code/diff.ts";
import { diffBlock, diffStats, simpleDiff } from "../extensions/shared/diff.ts";

test("uses the CLI's structured patch", () => {
	const diff = editDiff("Edit", {}, {
		structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" keep", "-old", "+new", "+more"] }],
	})!;
	assert.deepEqual(diff.lines, ["@@ -3,2 +3,3 @@", " keep", "-old", "+new", "+more"]);
	assert.equal(diffStats(diff), "+2 −1");
});

test("a created file is all additions", () => {
	const diff = editDiff("Write", { content: "a\nb\n" }, { type: "create", content: "a\nb\n", structuredPatch: [] })!;
	assert.deepEqual(diff.lines, ["+a", "+b"]);
	assert.equal(diffStats(diff), "+2");
});

test("falls back to old/new strings without a patch", () => {
	const diff = editDiff("Edit", { old_string: "x\ny\nz", new_string: "x\nY\nz" }, undefined)!;
	assert.deepEqual(diff.lines, [" x", "-y", "+Y", " z"]);
});

test("MultiEdit joins its edits", () => {
	const diff = editDiff("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }, undefined)!;
	assert.deepEqual(diff.lines, ["-a", "+b", "@@", "-c", "+d"]);
	assert.equal(diff.added, 2);
});

test("other tools have no diff", () => {
	assert.equal(editDiff("Bash", { command: "ls" }, {}), undefined);
});

test("simpleDiff keeps shared lines at both ends as context", () => {
	assert.deepEqual(simpleDiff("a\nb\nc", "a\nc").lines, [" a", "-b", " c"]);
});

test("diffBlock fences, cuts long diffs and survives backticks", () => {
	const long = { lines: Array.from({ length: 50 }, (_, i) => `+${i}`), added: 50, removed: 0 };
	const block = diffBlock(long).split("\n");
	assert.equal(block[0], "```diff");
	assert.equal(block.at(-2), "… 10 more lines");
	assert.equal(block.at(-1), "```");
	assert.ok(diffBlock({ lines: ["+```js"], added: 1, removed: 0 }).startsWith("````diff"));
});
