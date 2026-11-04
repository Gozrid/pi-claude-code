/**
 * Mermaid diagrams too wide for the chat: turned, or reported to the model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fitDiagram, mermaidSources, tooWideNote, turned, turnTooWide } from "../extensions/chat-view/diagrams.ts";
import { loadRenderer } from "../extensions/chat-view/mermaid.ts";

const render = (await loadRenderer())!;

const chain = "flowchart LR\n  A[Bluetooth verbunden] --> B[Dienst startet] --> C[GPS zeichnet auf] --> D[Fahrt gespeichert]";

test("pi's grok-mermaid is found", () => {
	assert.equal(typeof render, "function");
});

test("turning swaps left-right and top-down, keeps directives and indentation", () => {
	assert.equal(turned("flowchart LR\nA-->B"), "flowchart TD\nA-->B");
	assert.equal(turned("graph RL;\nA-->B"), "graph TD;\nA-->B");
	assert.equal(turned("flowchart TB\nA-->B"), "flowchart LR\nA-->B");
	assert.equal(turned("flowchart\nA-->B"), "flowchart LR\nA-->B");
	assert.equal(turned('%%{init: {"flowchart": {}}}%%\n  flowchart LR\nA-->B'), '%%{init: {"flowchart": {}}}%%\n  flowchart TD\nA-->B');
	assert.equal(turned("---\ntitle: x\n---\nflowchart LR\nA-->B"), "---\ntitle: x\n---\nflowchart TD\nA-->B");
	assert.equal(turned("sequenceDiagram\nA->>B: hi"), undefined);
});

test("a flowchart too wide is drawn turned, one that fits stays as it is", () => {
	const wide = render(chain)!.width;
	assert.equal(fitDiagram(chain, wide, render).kind, "fits");
	const fit = fitDiagram(chain, wide - 1, render);
	assert.equal(fit.kind, "turned");
	assert.ok(fit.kind === "turned" && fit.art.width < wide);
});

test("too wide either way is reported with the narrower width", () => {
	const fit = fitDiagram(chain, 10, render);
	assert.equal(fit.kind, "tooWide");
	const turnedWidth = render(turned(chain)!)!.width;
	assert.ok(fit.kind === "tooWide" && fit.width === Math.min(render(chain)!.width, turnedWidth));
});

test("diagrams that cannot be drawn at all are left to pi", () => {
	assert.equal(fitDiagram("pie\n  \"a\" : 1", 200, render).kind, "skip");
});

test("the Markdown gets the turned drawing as code rows; text around it stays", () => {
	const markdown = `Before\n\n\`\`\`mermaid\n${chain}\n\`\`\`\n\nAfter\n`;
	const out = turnTooWide(markdown, 40, render);
	assert.ok(out.startsWith("Before\n\n`"));
	assert.ok(out.includes("▼"));
	assert.ok(out.trimEnd().endsWith("After"));
	assert.ok(!out.includes("```mermaid"));
});

test("too wide either way stays source and is heard of", () => {
	const markdown = `\`\`\`mermaid\n${chain}\n\`\`\``;
	const heard: string[] = [];
	assert.equal(turnTooWide(markdown, 10, render, undefined, (source) => heard.push(source)), markdown);
	assert.deepEqual(heard, [chain]);
	assert.deepEqual(mermaidSources(`text\n\n${markdown}\n\n\`\`\`js\nx\n\`\`\``), [chain]);
});

test("the note names each diagram and the columns available", () => {
	const note = tooWideNote([{ source: `%%{init: {}}%%\n${chain}`, width: 120 }], 80);
	assert.match(note, /only 80 columns/);
	assert.match(note, /`flowchart LR` … needs 120 columns/);
	assert.match(note, /flowchart TD/);
});
